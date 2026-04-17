import "dotenv/config";

function mustEnv(name) {
  const raw = process.env[name];
  const value = raw?.trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

const apiKey = mustEnv("ODSAY_API_KEY");
/** ODsay WEB 키와 동일한 Origin — .env의 ODSAY_WEB_ORIGIN 우선, 없으면 프로덕션 Vercel URL */
function odsayWebOriginHeaders() {
  const raw = process.env.ODSAY_WEB_ORIGIN?.trim().replace(/^["']|["']$/g, "") ?? "";
  const origin = (raw || "https://midpoint-navigator.vercel.app").replace(/\/$/, "");
  return { Origin: origin, Referer: `${origin}/` };
}
const sx = process.argv[2] ?? "126.950783269518";
const sy = process.argv[3] ?? "37.3897837540429";
const ex = process.argv[4] ?? "126.941686527151";
const ey = process.argv[5] ?? "37.4824725161034";

const url =
  "https://api.odsay.com/v1/api/searchPubTransPathT" +
  `?SX=${sx}` +
  `&SY=${sy}` +
  `&EX=${ex}` +
  `&EY=${ey}` +
  `&apiKey=${apiKey}`;

console.log("[test-odsay] env", { apiKeyLength: apiKey.length });
console.log("[test-odsay] url", url);

try {
  const wh = odsayWebOriginHeaders();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Referer: wh.Referer,
      Origin: wh.Origin
    }
  });
  const text = await res.text();
  console.log("[test-odsay] status", res.status, res.statusText);
  console.log("[test-odsay] body", text);
} catch (error) {
  console.error("[test-odsay] network error", error);
  process.exit(1);
}
