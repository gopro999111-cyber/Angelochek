import { chromium } from "playwright";
import fs from "fs";
import fetch from "node-fetch";
import crypto from "crypto";
import { login } from "./login.js";

// ================= НАСТРОЙКИ =================
const TARGET_URL = "https://grnd.gg/admin/complaints";
const CHECK_INTERVAL = 30_000; // 30 секунд
const NOTIFIED_FILE = "./notified_ids.json";

// ===== DISCORD =====
const WEBHOOK_URL =
  "https://discord.com/api/webhooks/1466511287914598410/MRNNjznKKpDKW0l6cLG312lUs_j54YbVZHGA0AuEOawXqJR9r--5t7QM37MlVmwBbfBe";

// кого тегаем
const DISCORD_USER_ID = "1358773816867815486";

// ================= INIT STORAGE =================
if (!fs.existsSync(NOTIFIED_FILE)) {
  fs.writeFileSync(NOTIFIED_FILE, JSON.stringify([]));
}
const notifiedIds = new Set(JSON.parse(fs.readFileSync(NOTIFIED_FILE, "utf8")));

// ================= SAFETY =================
process.on("unhandledRejection", err => {
  console.error("❌ UNHANDLED REJECTION:", err);
});
process.on("uncaughtException", err => {
  console.error("❌ UNCAUGHT EXCEPTION:", err);
});

// ================= HELPERS =================
function stableId(rawId, text) {
  const id = (rawId ?? "").toString().trim();
  if (id) return id;
  return crypto.createHash("sha1").update(String(text ?? "")).digest("hex");
}

function clamp(text, max = 1800) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(0, max) + "\n…(обрезано)";
}

async function postToDiscord(text) {
  const payload = {
    content: `<@${DISCORD_USER_ID}>\n\n${text}`,
    allowed_mentions: {
      users: [DISCORD_USER_ID]
    }
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord webhook error ${res.status}: ${body}`);
  }
}

async function debugPage(page, prefix = "") {
  console.warn(prefix + "URL:", page.url());
  try {
    console.warn(prefix + "TITLE:", await page.title());
  } catch {}
}

// ================= MAIN =================
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // --- LOGIN ---
  await login(page);
  console.log("🤖 Бот запущен, мониторинг начат");

  while (true) {
    try {
      await page.goto(TARGET_URL, { waitUntil: "networkidle" });

      // если разлогинило — перелогиниваемся
      if (!page.url().includes("/admin/complaints")) {
        console.warn("⚠️ Не на странице жалоб, перелогин…");
        await debugPage(page, "   ");
        try { fs.unlinkSync("./auth.json"); } catch {}
        await login(page);
        await page.goto(TARGET_URL, { waitUntil: "networkidle" });
      }

      // ждём, пока SPA что-то нарисует
      await page.waitForTimeout(2000);

      const complaints = await page.$$eval(".complaint", els =>
        els.map(el => ({
          id: el.getAttribute("data-id"),
          text: (el.innerText || "").trim()
        }))
      ).catch(() => []);

      if (complaints.length === 0) {
        console.log("⏳ Жалоб нет");
        await debugPage(page, "   ");
      }

      for (const c of complaints) {
        const id = stableId(c.id, c.text);
        if (notifiedIds.has(id)) continue;

        const message =
          `🚨 **Новая жалоба** (ID: ${id})\n` +
          "```" +
          "\n" +
          clamp(c.text) +
          "\n```";

        try {
          await postToDiscord(message);
          notifiedIds.add(id);
          fs.writeFileSync(
            NOTIFIED_FILE,
            JSON.stringify([...notifiedIds], null, 2)
          );
          console.log("📨 Отправлено:", id);
        } catch (e) {
          console.error("❌ Не отправилось в Discord:", e.message);
        }
      }

    } catch (err) {
      console.error("❌ Ошибка цикла:", err.message);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
})();