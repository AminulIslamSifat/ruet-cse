const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const path = require("path");

module.exports = async (req, res) => {
  const week = (req.query.week || "odd").toLowerCase();
  if (!["odd", "even"].includes(week)) {
    return res.status(400).json({ error: "week must be 'odd' or 'even'" });
  }

  let browser;
  try {
    const execPath = await chromium.executablePath();

    // Ensure bundled shared libraries (.so) are discoverable by the loader, hello
    const libDir = path.dirname(execPath);
    process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH || ""]
      .filter(Boolean)
      .join(":");

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
      ],
      executablePath: execPath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

    const url = `https://ruet-cse-liart.vercel.app/routine/${week}`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    // Wait for the routine table to actually render (client-side JS)
    await page.waitForSelector(".routine-table", { timeout: 15000 });
    // Small extra delay for fonts/paint
    await new Promise((r) => setTimeout(r, 800));

    const screenshot = await page.screenshot({
      type: "png",
      fullPage: true,
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).send(screenshot);
  } catch (err) {
    console.error("[routine-image]", err);
    return res.status(500).json({ error: "Screenshot failed", detail: err.message });
  } finally {
    if (browser) await browser.close();
  }
};





