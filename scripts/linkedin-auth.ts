// One-time helper: run `npm run linkedin-auth`, approve access in your browser,
// then copy the printed LINKEDIN_ACCESS_TOKEN / LINKEDIN_PERSON_ID into .env.
// LinkedIn access tokens last ~60 days — re-run this script to refresh.
import { config as loadEnv } from "dotenv";
import http from "node:http";

loadEnv({ override: true });

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = "openid profile w_member_social";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in .env first (see README).");
  process.exit(1);
}

const state = Math.random().toString(36).slice(2);
const authUrl =
  `https://www.linkedin.com/oauth/v2/authorization?response_type=code` +
  `&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&state=${state}`;

console.log("\n1. Make sure http://localhost:3000/callback is added as a redirect URL on your LinkedIn app.");
console.log("2. Open this URL in your browser and approve access:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  if (!req.url) return res.end();
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.end();
    return;
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");

  if (!code || returnedState !== state) {
    res.end("Failed: missing code or state mismatch. Check the terminal for details.");
    console.error("OAuth callback missing code, or state did not match.");
    server.close();
    return;
  }

  try {
    const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    const tokenJson = (await tokenResponse.json()) as { access_token?: string; expires_in?: number; error_description?: string };

    if (!tokenJson.access_token) {
      res.end("Token exchange failed. Check the terminal.");
      console.error(tokenJson);
      server.close();
      return;
    }

    const userInfoResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    });
    const userInfo = (await userInfoResponse.json()) as { sub?: string };

    console.log("\n✅ Success! Add these lines to your .env:\n");
    console.log(`LINKEDIN_ACCESS_TOKEN=${tokenJson.access_token}`);
    console.log(`LINKEDIN_PERSON_ID=${userInfo.sub}`);
    if (tokenJson.expires_in) {
      console.log(`\n(Token expires in ~${Math.round(tokenJson.expires_in / 86400)} days — re-run this script to refresh it.)`);
    }

    res.end("Success! Check your terminal for the values to paste into .env, then close this tab.");
  } catch (err) {
    console.error(err);
    res.end("Something went wrong. Check the terminal.");
  } finally {
    server.close();
  }
});

server.listen(3000, () => {
  console.log("Waiting for LinkedIn to redirect back to http://localhost:3000/callback ...");
});
