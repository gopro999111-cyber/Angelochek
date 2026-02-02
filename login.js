import fs from "fs";

const AUTH_FILE = "./auth.json";
const TARGET_URL = "https://grnd.gg/admin/complaints";

async function maybeFillDiscordLogin(page, email, password) {
  // Discord login form
  const emailInput = page.locator('input[name="email"]');
  const passInput = page.locator('input[name="password"]');
  const submitBtn = page.locator('button[type="submit"]');

  if ((await emailInput.count()) && (await passInput.count())) {
    await emailInput.fill(email);
    await passInput.fill(password);
    await submitBtn.click();
    // Give Discord time to redirect
    await page.waitForTimeout(8000);
    return true;
  }
  return false;
}

async function maybeAuthorizeDiscordOauth(page) {
  // Discord OAuth "Authorize" screen
  const authorizeBtn = page.locator('button[type="submit"]:has-text("Authorize")');
  if (await authorizeBtn.count()) {
    await authorizeBtn.first().click();
    await page.waitForTimeout(6000);
    return true;
  }
  return false;
}

async function maybeStartOauthFromGrnd(page) {
  // On grnd.gg you may see a login button/link that starts Discord OAuth
  const candidates = [
    'a[href*="discord.com/oauth2/authorize"]',
    'a[href*="discord"]',
    'button:has-text("Discord")',
    'button:has-text("Login")',
    'a:has-text("Login")',
    'a:has-text("Sign in")',
    'button:has-text("Sign in")'
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel);
    if (await loc.count()) {
      try {
        await loc.first().click({ timeout: 2000 });
        await page.waitForTimeout(2500);
        return true;
      } catch {
        // ignore and try next
      }
    }
  }
  return false;
}

async function saveCookies(context) {
  const cookies = await context.cookies();
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies }, null, 2));
}

export async function login(page) {
  const email = process.env.DISCORD_LOGIN || process.env.DISCORD_EMAIL;
  const password = process.env.DISCORD_PASSWORD;

  if (!email || !password) {
    throw new Error("Missing env vars: set DISCORD_LOGIN (or DISCORD_EMAIL) and DISCORD_PASSWORD");
  }

  // Try to reuse cookies if present
  if (fs.existsSync(AUTH_FILE)) {
    console.log("🔐 Использую сохранённую сессию");
    const cookies = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
    await page.context().addCookies(cookies.cookies || cookies);
  }

  // Always navigate to the target page; if not authenticated, it will redirect or show a login prompt.
  console.log("🔑 Проверяю доступ к /admin/complaints");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // Try a few times to complete OAuth/login flow.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const url = page.url();

    // If we're on Discord login or OAuth, handle it.
    if (url.includes("discord.com/login")) {
      console.log("🔑 Логин в Discord (attempt", attempt + ")");
      await maybeFillDiscordLogin(page, email, password);
      continue;
    }

    if (url.includes("discord.com/oauth2") || url.includes("discord.com/api/oauth2")) {
      // Sometimes Discord shows an authorize screen.
      const didAuthorize = await maybeAuthorizeDiscordOauth(page);
      if (didAuthorize) {
        // After authorize it should redirect back.
        await page.waitForTimeout(3000);
      }
      continue;
    }

    // If we are on grnd.gg but complaints aren't visible yet, maybe we are on a login page.
    // Try to start OAuth from grnd.
    if (url.includes("grnd.gg") && !url.includes("/admin/complaints")) {
      console.log("🔑 Похоже, нужно войти на сайте (attempt", attempt + ") URL:", url);
      await maybeStartOauthFromGrnd(page);
      await page.waitForTimeout(2000);
      continue;
    }

    // If we're on the target page, consider login successful.
    if (url.includes("/admin/complaints")) {
      // Give SPA some time.
      await page.waitForTimeout(1500);
      await saveCookies(page.context());
      console.log("✅ Сессия сохранена");
      return;
    }

    // Fallback: go again to target
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
  }

  // If we got here, we couldn't reach the page.
  const finalUrl = page.url();
  throw new Error(`Login flow failed; final URL: ${finalUrl}`);
}
