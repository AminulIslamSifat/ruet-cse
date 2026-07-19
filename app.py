from dotenv import load_dotenv
load_dotenv()

import os
import json
from pathlib import Path
from urllib.parse import quote_plus
from flask import Flask, render_template, request, redirect, url_for, jsonify
from pymongo import MongoClient
from bson.objectid import ObjectId
import bson
from datetime import datetime, date, timezone, timedelta
import re

app = Flask(__name__)

BASE_DIR = Path(__file__).parent

# ── MongoDB ────────────────────────────────────────────────────────────────
MONGODB_USERNAME     = os.environ.get("MONGODB_USERNAME", "")
MONGODB_USER_PASSWORD = os.environ.get("MONGODB_USER_PASSWORD", "")

client       = MongoClient(f"mongodb+srv://{quote_plus(MONGODB_USERNAME)}:{quote_plus(MONGODB_USER_PASSWORD)}@cluster0.5ckeilq.mongodb.net/?appName=Cluster0")
schedule_db  = client["schedule"]
phantom_db   = client["phantom_bot_db"]

SCHEDULE_TYPES = ["CT", "Assignment", "Semester Final", "Backlog"]


def get_collection(schedule_type: str):
    return schedule_db[schedule_type.lower().replace(" ", "_")]


def normalize(key: str) -> str:
    return re.sub(r"[\s\-]+", "", key).upper()


def _routine_path(week: str) -> Path:
    return BASE_DIR / f"routine_{week}_week.json"


def _load_routine(week: str) -> dict:
    try:
        doc = phantom_db["routine"].find_one({"_id": f"{week}_week"})
        if doc:
            doc.pop("_id", None)
            doc.pop("updated_at", None)
            doc.pop("week", None)
            return doc
    except Exception as e:
        print(f"[_load_routine] MongoDB fetch error: {e}")

    p = _routine_path(week)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"periods": [], "times": [], "routine": []}


# ────────────────────────────────────────────────────────────────────────────
# Homepage
# ────────────────────────────────────────────────────────────────────────────

@app.route("/")
def home():
    schedule_count   = sum(get_collection(t).count_documents({}) for t in SCHEDULE_TYPES)
    teachers_count   = phantom_db["subject_teachers"].count_documents({})
    experiments_count = phantom_db["subject_experiments"].count_documents({})
    return render_template("index.html",
        schedule_count=schedule_count,
        teachers_count=teachers_count,
        experiments_count=experiments_count,
    )


# ────────────────────────────────────────────────────────────────────────────
# Routine — display & data API
# ────────────────────────────────────────────────────────────────────────────

@app.route("/routine/<week>")
def routine_display(week):
    if week not in ("odd", "even"):
        return "Not found", 404
    data = _load_routine(week)
    return render_template("routine_display.html", week=week, data=data)


@app.route("/routine/data/<week>.json")
def routine_data(week):
    if week not in ("odd", "even"):
        return jsonify({"error": "Not found"}), 404
    return jsonify(_load_routine(week))


@app.route("/routine/editor")
def routine_editor():
    return render_template("routine_editor.html")


@app.route("/routine/save", methods=["POST"])
def routine_save():
    payload = request.get_json(silent=True) or {}
    week = payload.get("week")
    data = payload.get("data")

    if week not in ("odd", "even") or not data:
        return jsonify({"error": "Invalid payload"}), 400

    try:
        _routine_path(week).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"[routine_save] Local JSON write failed (expected on serverless): {e}")

    try:
        phantom_db["routine"].replace_one(
            {"_id": f"{week}_week"},
            {"_id": f"{week}_week", "week": week, **data, "updated_at": datetime.utcnow()},
            upsert=True,
        )
    except Exception as e:
        print(f"[routine_save] MongoDB error: {e}")

    return jsonify({"ok": True})


# ────────────────────────────────────────────────────────────────────────────
# Schedule CRUD
# ────────────────────────────────────────────────────────────────────────────

@app.route("/schedule")
def schedule_index():
    upcoming = []
    tz_dhaka = timezone(timedelta(hours=6))
    today = datetime.now(tz_dhaka).date()
    for stype in SCHEDULE_TYPES:
        for doc in get_collection(stype).find():
            doc["_id"] = str(doc["_id"])
            doc["type"] = stype
            doc["countdown"] = doc["countdown_class"] = ""
            if doc.get("date"):
                try:
                    delta = (datetime.strptime(doc["date"], "%Y-%m-%d").date() - today).days
                    if delta == 0:   doc["countdown"], doc["countdown_class"] = "Today",             "today"
                    elif delta == 1: doc["countdown"], doc["countdown_class"] = "Tomorrow",          "tomorrow"
                    elif delta > 1:  doc["countdown"], doc["countdown_class"] = f"{delta}d left",    "upcoming"
                    else:            doc["countdown"], doc["countdown_class"] = f"{abs(delta)}d ago", "past"
                except Exception:
                    pass
            upcoming.append(doc)
    upcoming.sort(key=lambda s: (s.get("date") or "9999-12-31", s.get("time") or ""))
    return render_template("schedule_index.html", schedules=upcoming, types=SCHEDULE_TYPES)


@app.route("/schedule/add", methods=["POST"])
def add_schedule():
    stype = request.form.get("type")
    if stype not in SCHEDULE_TYPES:
        return "Invalid schedule type", 400
    subject = request.form.get("subject", "").strip()
    teacher = request.form.get("teacher", "").strip()
    if not subject or not teacher:
        return "Subject and Teacher are required", 400
    get_collection(stype).insert_one({
        "subject":  subject,
        "teacher":  teacher,
        "date":     request.form.get("date", "").strip(),
        "time":     request.form.get("time", "").strip(),
        "topic":    request.form.get("topic", "").strip(),
        "syllabus": request.form.get("syllabus", "").strip(),
    })
    return redirect(url_for("schedule_index"))


@app.route("/schedule/edit/<stype>/<oid>", methods=["GET", "POST"])
def edit_schedule(stype, oid):
    matched = next((t for t in SCHEDULE_TYPES if t.lower().replace(" ", "_") == stype.lower()), None)
    if not matched:
        return "Invalid schedule type", 400
    try:
        oid_obj = ObjectId(oid)
    except bson.errors.InvalidId:
        return "Invalid ID", 404
    col = get_collection(matched)
    if request.method == "POST":
        subject = request.form.get("subject", "").strip()
        teacher = request.form.get("teacher", "").strip()
        if not subject or not teacher:
            return "Subject and Teacher are required", 400
        col.update_one({"_id": oid_obj}, {"$set": {
            "subject":  subject,
            "teacher":  teacher,
            "date":     request.form.get("date", "").strip(),
            "time":     request.form.get("time", "").strip(),
            "topic":    request.form.get("topic", "").strip(),
            "syllabus": request.form.get("syllabus", "").strip(),
        }})
        return redirect(url_for("schedule_index"))
    doc = col.find_one({"_id": oid_obj})
    if not doc:
        return "Not found", 404
    doc["_id"] = str(doc["_id"])
    doc["type"] = matched
    return render_template("schedule_edit.html", schedule=doc, types=SCHEDULE_TYPES)


@app.route("/schedule/delete/<stype>/<oid>", methods=["POST"])
def delete_schedule(stype, oid):
    matched = next((t for t in SCHEDULE_TYPES if t.lower().replace(" ", "_") == stype.lower()), None)
    if not matched:
        return "Invalid schedule type", 400
    try:
        get_collection(matched).delete_one({"_id": ObjectId(oid)})
    except bson.errors.InvalidId:
        return "Invalid ID", 404
    return redirect(url_for("schedule_index"))


# ────────────────────────────────────────────────────────────────────────────
# Subject Experiments CRUD
# ────────────────────────────────────────────────────────────────────────────

@app.route("/experiments")
def experiments():
    docs = list(phantom_db["subject_experiments"].find())
    for d in docs:
        d["_id"] = str(d["_id"])
    return render_template("experiments.html", subjects=docs)


@app.route("/experiments/add", methods=["POST"])
def add_experiment_subject():
    subject = request.form.get("subject", "").strip()
    stype   = request.form.get("type", "sessional").strip()
    if not subject:
        return "Subject name is required", 400
    norm = normalize(subject)
    if not phantom_db["subject_experiments"].find_one({"normalized": norm}):
        phantom_db["subject_experiments"].insert_one({
            "subject": subject, "normalized": norm, "type": stype, "experiments": {}
        })
    return redirect(url_for("experiments"))


@app.route("/experiments/edit/<oid>", methods=["GET", "POST"])
def edit_experiment_subject(oid):
    try:
        oid_obj = ObjectId(oid)
    except bson.errors.InvalidId:
        return "Invalid ID", 404
    doc = phantom_db["subject_experiments"].find_one({"_id": oid_obj})
    if not doc:
        return "Not found", 404
    if request.method == "POST":
        action = request.form.get("action")
        if action == "update_meta":
            phantom_db["subject_experiments"].update_one({"_id": oid_obj}, {"$set": {"type": request.form.get("type", "sessional")}})
        elif action == "add_exp":
            exp_no, exp_title, exp_type = (
                request.form.get("exp_no", "").strip(),
                request.form.get("exp_title", "").strip(),
                request.form.get("exp_type", "Lab Report").strip(),
            )
            if exp_no and exp_title:
                experiments = doc.get("experiments", {})
                experiments[exp_no] = {"type": exp_type, "title": exp_title}
                phantom_db["subject_experiments"].update_one({"_id": oid_obj},
                    {"$set": {"experiments": experiments}})
        elif action == "delete_exp":
            exp_no = request.form.get("exp_no", "").strip()
            if exp_no:
                experiments = doc.get("experiments", {})
                if exp_no in experiments:
                    del experiments[exp_no]
                    phantom_db["subject_experiments"].update_one({"_id": oid_obj},
                        {"$set": {"experiments": experiments}})
        return redirect(url_for("edit_experiment_subject", oid=oid))
    doc["_id"] = str(doc["_id"])
    experiments_sorted = dict(sorted(
        doc.get("experiments", {}).items(),
        key=lambda x: int(x[0]) if x[0].isdigit() else 9999
    ))
    return render_template("edit_experiment.html", subject=doc, experiments=experiments_sorted)


@app.route("/experiments/delete/<oid>", methods=["POST"])
def delete_experiment_subject(oid):
    try:
        phantom_db["subject_experiments"].delete_one({"_id": ObjectId(oid)})
    except bson.errors.InvalidId:
        return "Invalid ID", 404
    return redirect(url_for("experiments"))


# ────────────────────────────────────────────────────────────────────────────
# Subject Teachers CRUD
# ────────────────────────────────────────────────────────────────────────────

@app.route("/teachers")
def teachers():
    docs = list(phantom_db["subject_teachers"].find())
    for d in docs:
        d["_id"] = str(d["_id"])
    return render_template("teachers.html", subjects=docs)


@app.route("/teachers/add", methods=["POST"])
def add_teacher_subject():
    subject = request.form.get("subject", "").strip()
    title   = request.form.get("title", "").strip()
    stype   = request.form.get("type", "sessional").strip()
    if not subject:
        return "Subject name is required", 400
    norm = normalize(subject)
    if not phantom_db["subject_teachers"].find_one({"normalized": norm}):
        phantom_db["subject_teachers"].insert_one({
            "subject": subject, "normalized": norm, "title": title,
            "type": stype, "1": {}, "2": {}
        })
    return redirect(url_for("teachers"))


@app.route("/teachers/edit/<oid>", methods=["GET", "POST"])
def edit_teacher_subject(oid):
    try:
        oid_obj = ObjectId(oid)
    except bson.errors.InvalidId:
        return "Invalid ID", 404
    doc = phantom_db["subject_teachers"].find_one({"_id": oid_obj})
    if not doc:
        return "Not found", 404
    if request.method == "POST":
        action = request.form.get("action")
        if action == "update_meta":
            phantom_db["subject_teachers"].update_one({"_id": oid_obj}, {"$set": {
                "title": request.form.get("title", "").strip(),
                "type":  request.form.get("type", "sessional"),
            }})
        elif action == "update_teacher":
            key = request.form.get("key", "1")
            if key in ("1", "2"):
                phantom_db["subject_teachers"].update_one({"_id": oid_obj}, {"$set": {key: {
                    "name":        request.form.get("name", "").strip(),
                    "designation": request.form.get("designation", "").strip(),
                    "department":  request.form.get("department", "").strip(),
                    "dept_short":  request.form.get("dept_short", "").strip(),
                }}})
        return redirect(url_for("edit_teacher_subject", oid=oid))
    doc["_id"] = str(doc["_id"])
    return render_template("edit_teacher.html", subject=doc)


@app.route("/teachers/delete/<oid>", methods=["POST"])
def delete_teacher_subject(oid):
    try:
        phantom_db["subject_teachers"].delete_one({"_id": ObjectId(oid)})
    except bson.errors.InvalidId:
        return "Invalid ID", 404
    return redirect(url_for("teachers"))


if __name__ == "__main__":
    app.run(debug=True)
