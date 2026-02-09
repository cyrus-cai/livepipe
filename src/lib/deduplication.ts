import type { IntentResult } from "./schemas";

const COOLDOWN_MS = 300_000; // 5 minutes cooldown
const SIMILARITY_THRESHOLD = 0.6; // 60% similar = duplicate

interface RecentItem {
  content: string;
  type: string;
  time: number;
}

const recentItems: RecentItem[] = [];

/**
 * Simple Levenshtein-based similarity (0-1).
 * Good enough for comparing short task descriptions.
 */
function similarity(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;

  // For performance, if lengths differ by >50%, they're probably different
  if (Math.abs(la - lb) / Math.max(la, lb) > 0.5) return 0;

  // Use a simplified comparison: normalize and check overlap of words/chars
  const na = a.toLowerCase().replace(/\s+/g, " ").trim();
  const nb = b.toLowerCase().replace(/\s+/g, " ").trim();

  if (na === nb) return 1;

  // Character bigram overlap (Dice coefficient) — fast and effective
  const bigramsA = new Set<string>();
  for (let i = 0; i < na.length - 1; i++) bigramsA.add(na.slice(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < nb.length - 1; i++) bigramsB.add(nb.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }

  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Check if this intent result should trigger a notification.
 * Returns true if it should be sent, false if it's a duplicate or too similar.
 */
export function shouldNotify(result: IntentResult): boolean {
  if (!result.actionable) return false;

  const now = Date.now();

  // Cleanup expired entries
  while (recentItems.length > 0 && now - recentItems[0].time > COOLDOWN_MS * 2) {
    recentItems.shift();
  }

  // Check against all recent items for similarity
  for (const item of recentItems) {
    if (now - item.time > COOLDOWN_MS) continue;

    const sim = similarity(result.content, item.content);
    if (sim >= SIMILARITY_THRESHOLD) {
      console.log(
        `[dedup] skipping similar content (${(sim * 100).toFixed(0)}% match, ${Math.round((now - item.time) / 1000)}s ago): "${result.content.substring(0, 50)}"`
      );
      return false;
    }
  }

  // Record this item
  recentItems.push({
    content: result.content,
    type: result.type,
    time: now,
  });

  // Keep array bounded
  if (recentItems.length > 50) {
    recentItems.splice(0, recentItems.length - 50);
  }

  return true;
}
