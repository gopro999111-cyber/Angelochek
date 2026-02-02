import { chromium } from "playwright";
import fs from "fs";
import fetch from "node-fetch";

// ====== НАСТРОЙКИ ======
const URL = "https://grnd.gg/admin/complaints";
const CHECK_INTERVAL = 30_000; // 30 секунд
const STORAGE_FILE = "notified_ids.json";

// ====== DISCORD ======
const DISCORD_WEBHOOK =
  "https://discord.com/api/webhooks/1466511287914598410/MRNNjznKKpDKW0l6cLG312lUs_j54YbVZHGA0AuEOawXqJR9r--5t7QM37MlVmwBbfBe";

// ✅ ТЕГАЕМ РОЛЬ (задай в Variables / .env)
const DISCORD_ROLE_ID = process.env.DISCORD_ROLE_ID;

// ====== БЕЗОПАСНОСТЬ ПРОЦЕССА ======
process.on("unhandledRejection", err => {
  console.error("❌ UNHANDLED REJECTION:", err?.stack || err);
});
process.on("uncaughtException", err => {
  console.error("❌ UNCAUGHT EXCEPTION:", err?.stack || err);
});

// ====== ЗАГРУЗКА ID ======
const notified = fs.existsSync(STORAGE_FILE)
  ? new Set(JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8")))
  : new Set();

function saveNotified() {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify([...notified], null, 2));
}

// ====== DISCORD SEND (с ретраями) ======
async function sendDiscord(c) {
  if (!DISCORD_ROLE_ID) {
    throw new Error("DISCORD_ROLE_ID не задан. Добавь переменную окружения DISCORD_ROLE_ID (ID роли).");
  }

  const payload = {
    content: `<@&${DISCORD_ROLE_ID}>`,
    allowed_mentions: { roles: [DISCORD_ROLE_ID] },
    embeds: [
      {
        title: "🚨 Новая жалоба",
        color: 15158332,
        fields: [
          { name: "ID", value: `#${c.id}`, inline: true },
          { name: "От", value: c.from || "—", inline: true },
          { name: "На", value: c.on || "—", inline: true },
          { name: "Дата", value: c.date || "—" }
        ],
        footer: { text: "grnd.gg • admin panel" },
        timestamp: new Date().toISOString()
      }
    ]
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) return;

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader
        ? Math.ceil(Number(retryAfterHeader) * 1000)
        : 3000;

      console.warn(`⚠️ Discord 429 (attempt ${attempt}/5), жду ${retryAfterMs}ms`);
      await new Promise(r => setTimeout(r, retryAfterMs));
      continue;
    }

    const text = await res.text().catch(() => "");
    throw new Error(
      `Discord webhook error ${res.status} ${res.statusText}: ${text}`.slice(0, 800)
    );
  }

  throw new Error("Discord webhook failed after retries (429)");
}

// ====== ИЗВЛЕЧЕНИЕ ЖАЛОБ (ТАБЛИЦА) ======
async function getComplaints(page) {
  // Ждём таблицу (если жалоб 0 — таблица обычно всё равно есть, но строк может не быть)
  await page.waitForSelector(".table-component-index table", { timeout: 20000 });

  const complaints = await page.evaluate(() => {
    return [...document.querySelectorAll(".table-component-index table tbody tr")]
      .map(row => {
        const tds = row.querySelectorAll("td");
        if (tds.length < 4) return null;

        return {
          id: tds[0].innerText.trim(),
          from: tds[1].innerText.trim(),
          on: tds[2].innerText.trim(),
          date: tds[3].innerText.trim()
        };
      })
      .filter(Boolean);
  });

  return complaints;
}

// ====== MAIN ======
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: "auth.json"
  });

  const page = await context.newPage();

  console.log("🤖 Бот запущен, мониторинг начат");

  while (true) {
    try {
      await page.goto(URL, { waitUntil: "networkidle" });

      // Если вдруг редиректнуло на логин — значит auth.json невалиден
      if (page.url().includes("/login")) {
        throw new Error("Не авторизован: открылась страница логина (auth.json не применился)");
      }

      const complaints = await getComplaints(page);
      console.log(`📄 Найдено жалоб на странице: ${complaints.length}`);

      let sent = 0;

      for (const c of complaints) {
        if (!c?.id) continue;
        if (notified.has(c.id)) continue;

        // notified.add только после успешной отправки
        await sendDiscord(c);
        notified.add(c.id);
        sent++;

        await new Promise(r => setTimeout(r, 400));
      }

      if (sent > 0) {
        saveNotified();
        console.log(`✅ Отправлено новых жалоб: ${sent}`);
      } else {
        console.log("⏳ Новых жалоб нет");
      }
    } catch (err) {
      console.error("❌ Ошибка:", err?.message || err);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL));
  }
})();
