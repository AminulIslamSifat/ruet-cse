# RUET CSE Routine & Academic Hub

A unified Python application displaying routines, academic schedules, subject teachers, and experiments for RUET CSE.

## 🛠 Setup & Local Running (uv)

This project uses the `uv` tool for fast Python package management.

### Installation

Install dependencies and create a virtual environment in one command:
```bash
uv sync
```

### Running Locally

Run the Flask application:
```bash
uv run python app.py
```
Open `http://127.0.0.1:5000` in your web browser.

## ⚙️ Environment Variables

Create a `.env` file in the root directory (copied automatically if tested locally):
```env
MONGODB_USERNAME=your_mongodb_username
MONGODB_USER_PASSWORD=your_mongodb_password
```
