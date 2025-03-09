require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");
const fs = require("fs");
const axios = require("axios");


puppeteer.use(StealthPlugin());

const FACEBOOK_LOGIN_URL = "https://www.facebook.com/login";
const FACEBOOK_HOME_URL = "https://www.facebook.com/";
//Facebook videos in sort by most recent order
const FACEBOOK_SEARCH_VIDEOS_URL = (query) =>
  `https://www.facebook.com/search/videos/?q=${encodeURIComponent(query)}&filters=eyJ2aWRlb3Nfc29ydF9ieTowIjoie1wibmFtZVwiOlwidmlkZW9zX3NvcnRfYnlcIixcImFyZ3NcIjpcIk1vc3QgUmVjZW50XCJ9In0%3D`;
const FACEBOOK_SEARCH_POSTS_URL = (query) => `https://www.facebook.com/search/posts/?q=${encodeURIComponent(query)}&filters=eyJyZWNlbnRfcG9zdHM6MCI6IntcIm5hbWVcIjpcInJlY2VudF9wb3N0c1wiLFwiYXJnc1wiOlwiXCJ9In0%3D`;

const SEARCH_QUERIES = process.env.SEARCH_QUERIES ? process.env.SEARCH_QUERIES.split(",") : ["zeezoo"];

const FB_EMAIL = process.env.FB_EMAIL;
const FB_PASSWORD = process.env.FB_PASSWORD;
const SESSION_FILE_PATH = "session.json";
const API_ENDPOINT = "https://wapi.websays.com/winput/fb/spider/clippings";
const { createClient } = require("redis");

// Create Redis client
const redisClient = createClient();

redisClient.on("error", (err) => console.error("❌ Redis Client Error:", err));

async function launchBrowser() {
  return await puppeteer.launch({
    headless: false,
    devtools: true,
    slowMo: 100,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    userDataDir: "./fb_session",
  });
}

async function loginToFacebook(page) {
  console.log("🔑 Checking Facebook Login...");

  // Load session cookies if available
  if (fs.existsSync(SESSION_FILE_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE_PATH));
    await page.setCookie(...cookies);
    await page.goto(FACEBOOK_HOME_URL, { waitUntil: "networkidle2" });

    // Check if already logged in
    const isLoggedIn = await page.evaluate(() =>
      document.body.innerText.includes("Find Friends")
    );
    if (isLoggedIn) {
      console.log("✅ Already logged in.");
      return;
    }
  }

  console.log("🔓 Logging into Facebook...");
  await page.goto(FACEBOOK_LOGIN_URL, { waitUntil: "domcontentloaded" });

  try {
    // Wait for email field, but allow login check
    const emailSelector = 'input[id="email"], input[name="email"]';
    const passSelector = 'input[id="pass"], input[name="pass"]';
    const loginBtnSelector = 'button[name="login"], button[type="submit"]';

    const emailField = await page.$(emailSelector);
    if (!emailField) {
      console.log("✅ Already logged in (login form not found).");
      return;
    }

    await page.type(emailSelector, FB_EMAIL, { delay: 100 });
    await page.type(passSelector, FB_PASSWORD, { delay: 100 });

    await page.waitForSelector(loginBtnSelector, { timeout: 5000 });
    await page.click(loginBtnSelector);

    // Detect CAPTCHA or manual verification
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const captchaExists = await page.evaluate(
      () => document.querySelector('img[alt="captcha"]') !== null
    );

    if (captchaExists) {
      console.log("⚠️ CAPTCHA detected! Solve manually and press Enter.");
      await new Promise((resolve) => process.stdin.once("data", resolve));
    }

    await page.waitForNavigation({ waitUntil: "networkidle2" });

    // Check if login succeeded
    const isLoginSuccess = await page.evaluate(
      () => !document.body.innerText.includes("Find your account")
    );
    if (!isLoginSuccess) {
      console.log(
        "❌ Login failed! Check credentials or manual verification required."
      );
      process.exit(1);
    }

    // Save session cookies
    const cookies = await page.cookies();
    fs.writeFileSync(SESSION_FILE_PATH, JSON.stringify(cookies));

    console.log("✅ Logged in and session saved.");
  } catch (error) {
    console.error("❌ Login failed due to missing elements:", error);
    process.exit(1);
  }
}


async function navigateToSearch(page, query) {
  if (page.isClosed()) {
    console.error("❌ Error: Attempted to use a closed page.");
    return;
  }

  console.log(`🔍 Searching for videos: "${query}"`);
  try {
    await page.goto(FACEBOOK_SEARCH_VIDEOS_URL(query), { waitUntil: "networkidle2" });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } catch (error) {
    console.error(`❌ Error navigating to search page for "${query}":`, error);
  }
}


async function scrollToEnd(page) {
  let previousHeight = 0;
  for (let i = 0; i < 3; i++) {
    let newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === previousHeight) break;
    previousHeight = newHeight;
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function scrapeFacebookVideos(query, page) {
  if (page.isClosed()) {
    console.error(`❌ Error: Attempted to scrape using a closed page.`);
    return [];
  }

  await navigateToSearch(page, query);

  try {
    await page.waitForSelector("div.x1yztbdb", { timeout: 10000 });
  } catch (error) {
    console.error(`⚠️ No search results found for "${query}" or page structure changed.`);
    return [];
  }

  await scrollToEnd(page);
  const htmlContent = await page.content();
  const $ = cheerio.load(htmlContent);

  let videoResults = [];
  $("div.x1yztbdb").each((_, element) => {
    let videoUrl = $(element).find('a[href*="/watch/"]').attr("href");
    if (videoUrl) videoUrl = `https://www.facebook.com${videoUrl}`;
    const thumbnail = $(element).find("img.xz74otr").attr("src") || "";
    const duration = $(element).find("span.video-duration").text().trim() || "Unknown";
    const title = $(element).find("h2 a, div[role='link']").first().text().trim();
    const viewsText = $(element).find("div:contains('views')").text().match(/(\d+(?:,\d+)*)/);
    const views = viewsText ? parseInt(viewsText[1].replace(/,/g, ""), 10) : 0;
    const uploaderName = $(element).find("a[href*='/profile.php?id='], a[href^='/']").first().text().trim() || "Unknown";
    let uploaderProfileUrl = $(element).find("a[href*='/profile.php?id='], a[href^='/']").attr("href");
    if (uploaderProfileUrl) uploaderProfileUrl = `https://www.facebook.com${uploaderProfileUrl}`;

    const videoData = {
      title: title || "Untitled",
      image: thumbnail,
      time: duration,
      profileId: uploaderName,
      postUrl: videoUrl,
      thumbnail,
      duration,
      views,
    };

    videoResults.push(videoData);
  });

  return videoResults;
}

async function scrapeFacebookPosts(query, page) {
  if (page.isClosed()) return [];

  await navigateToSearch(page, query);

  try {
    await page.waitForSelector("div.post-selector", { timeout: 10000 });
  } catch (error) {
    console.error(`⚠️ No posts found for "${query}".`);
    return [];
  }

  await scrollToEnd(page);
  const htmlContent = await page.content();
  const $ = cheerio.load(htmlContent);
  
  let postResults = [];
  $("div.post-selector").each((_, element) => {
    const postUrl = $(element).find("a").attr("href") || "";
    const content = $(element).find("p").text().trim() || "No content available";

    postResults.push({ postUrl, content });
  });

  return postResults;
}

async function scrapeFacebookPages(query, page) {
  if (page.isClosed()) return [];

  await navigateToSearch(page, query);

  try {
    await page.waitForSelector("div.page-selector", { timeout: 10000 });
  } catch (error) {
    console.error(`⚠️ No pages found for "${query}".`);
    return [];
  }

  await scrollToEnd(page);
  const htmlContent = await page.content();
  const $ = cheerio.load(htmlContent);
  
  let pageResults = [];
  $("div.page-selector").each((_, element) => {
    const pageUrl = $(element).find("a").attr("href") || "";
    const name = $(element).find("h2").text().trim() || "Unknown Page";

    pageResults.push({ pageUrl, name });
  });

  return pageResults;
}


async function uploadResultsToAPI(results,type) {
  try {
    //await axios.post(API_ENDPOINT, { data: results });
    console.log("✅ Result uploaded successfully of",type);
  } catch (error) {
    console.error("❌ Error uploading data:", error);
  }
}

// ✅ Function to shuffle/rotate the array randomly
function randomlyRotateArray(arr) {
  if (!arr.length) return arr;
  const randomIndex = Math.floor(Math.random() * arr.length);
  return [...arr.slice(randomIndex), ...arr.slice(0, randomIndex)];
}

(async () => {
  await redisClient.connect(); // ✅ Required for Redis v4+
  redisClient.on("connect", () => console.log("✅ Redis connected"));
redisClient.on("error", (err) => console.error("❌ Redis Error:", err));

})();

async function getSearchQueriesFromRedis() {
  try {
    const values = await redisClient.sMembers("fb_channels"); // ✅ Correct method
    return randomlyRotateArray(values); // Shuffle if needed
  } catch (error) {
    console.error("❌ Error fetching search queries from Redis:", error);
    return [];
  }
}



(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await loginToFacebook(page);


/*   const values = await getSearchQueriesFromRedis(); // ✅ Fetch search terms from Redis
  if (values.length === 0) {
    console.log("⚠️ No search queries found in Redis.");
    await browser.close();
    await redisClient.quit();
    return;
  }
  let allResults = [];
  for (const value of values) {
    const searchQuery = value.split(":")[1]; // Extract search term
    console.log(`🔎 Processing search term: ${searchQuery}`);

    try {
      const results = await scrapeFacebookVideos(searchQuery, page);
      allResults.push(...results);
    } catch (error) {
      console.error(`❌ Error scraping ${searchQuery}:`, error);
    }
  } */


  // Searching using env variables (remove later if needed)
  for (const query of SEARCH_QUERIES) {
    const newPage = await browser.newPage(); // Open a fresh page for each query
    
    const videoResults = await scrapeFacebookVideos(query, newPage) || [];
    for (const video of videoResults) {
      await uploadResultsToAPI(video,'video');
    }
    
    const postResults = await scrapeFacebookPosts(query, newPage) || [];
    for (const post of postResults) {
      await uploadResultsToAPI(post,'post');
    }
    
    const pageResults = await scrapeFacebookPages(query, newPage) || [];
    for (const page of pageResults) {
      await uploadResultsToAPI(page,'page');
    }
    
    await newPage.close(); // Close it after scraping
  }


  await browser.close();
  await redisClient.quit(); // ✅ Properly close Redis connection
})();
