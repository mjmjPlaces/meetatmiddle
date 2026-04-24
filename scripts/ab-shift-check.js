import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { findMidpoints } from "../server/midpointService.ts";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const CASES = [
  ["수색역", "잠원역", "범계역"],
  ["남태령역", "선바위역", "잠원역"],
  ["신도림역", "문정역", "범계역"],
  ["왕십리역", "합정역", "잠실역"]
];

const THRESHOLDS = {
  allowTop1ChangeCount: 1,
  maxAvgDeltaMinutes: 6,
  maxScoreDelta: 12
};

function normalizeStationLabel(name) {
  return String(name ?? "")
    .replace(/\s+/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\d+호선/g, "")
    .replace(/역$/, "");
}

function summarize(results) {
  return (results ?? []).slice(0, 3).map((r) => ({
    candidate: r?.candidate?.name ?? "",
    normalizedCandidate: normalizeStationLabel(r?.candidate?.name ?? ""),
    shiftedFrom: r?.candidate?.shiftedFrom ?? null,
    avg: Number((r?.averageMinutes ?? 0).toFixed(1)),
    max: Number(r?.maxMinutes ?? 0),
    score: Number((r?.score ?? 0).toFixed(2))
  }));
}

async function runWithShiftFlag(friends, enabled) {
  process.env.ENABLE_SHIFT_TARGETS = enabled ? "true" : "false";
  const req = {
    friends: friends.map((address, idx) => ({
      id: `f${idx + 1}`,
      name: `친구${idx + 1}`,
      address
    })),
    options: { topN: 3, maxCandidates: 12, transferPenalty: 8 }
  };
  const results = await findMidpoints(req);
  return summarize(results);
}

async function main() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => {
    if (String(args?.[0] ?? "").startsWith("[AB]")) {
      originalLog(...args);
    }
  };
  console.warn = (...args) => {
    if (String(args?.[0] ?? "").startsWith("[AB]")) {
      originalWarn(...args);
    }
  };

  const startedAt = new Date().toISOString();
  const caseReports = [];
  let top1ChangedCount = 0;
  let worstAvgDelta = 0;
  let worstScoreDelta = 0;

  for (const friends of CASES) {
    const on = await runWithShiftFlag(friends, true);
    const off = await runWithShiftFlag(friends, false);
    const topOn = on[0];
    const topOff = off[0];
    const top1Changed = topOn?.normalizedCandidate !== topOff?.normalizedCandidate;
    if (top1Changed) top1ChangedCount += 1;

    const avgDelta = Math.abs((topOn?.avg ?? 0) - (topOff?.avg ?? 0));
    const scoreDelta = Math.abs((topOn?.score ?? 0) - (topOff?.score ?? 0));
    worstAvgDelta = Math.max(worstAvgDelta, avgDelta);
    worstScoreDelta = Math.max(worstScoreDelta, scoreDelta);

    caseReports.push({
      friends,
      shiftOnTop3: on,
      shiftOffTop3: off,
      top1Changed,
      avgDeltaTop1: Number(avgDelta.toFixed(1)),
      scoreDeltaTop1: Number(scoreDelta.toFixed(2))
    });
  }

  const pass =
    top1ChangedCount <= THRESHOLDS.allowTop1ChangeCount &&
    worstAvgDelta <= THRESHOLDS.maxAvgDeltaMinutes &&
    worstScoreDelta <= THRESHOLDS.maxScoreDelta;

  const report = {
    startedAt,
    thresholds: THRESHOLDS,
    summary: {
      pass,
      top1ChangedCount,
      caseCount: CASES.length,
      worstAvgDeltaTop1: Number(worstAvgDelta.toFixed(1)),
      worstScoreDeltaTop1: Number(worstScoreDelta.toFixed(2))
    },
    cases: caseReports
  };

  const outputPath = path.resolve("docs", "ab-shift-report.latest.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  originalLog(`[AB] pass=${report.summary.pass}`);
  originalLog(`[AB] top1ChangedCount=${top1ChangedCount}/${CASES.length}`);
  originalLog(`[AB] worstAvgDeltaTop1=${report.summary.worstAvgDeltaTop1} min`);
  originalLog(`[AB] worstScoreDeltaTop1=${report.summary.worstScoreDeltaTop1}`);
  originalLog(`[AB] report=${outputPath}`);
}

main().catch((error) => {
  console.error("[AB] failed", error);
  process.exit(1);
});
