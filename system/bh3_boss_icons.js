/** Correct the one known casing mismatch in the BH3 boss icon CDN. */
export function fixBh3BossIconCase(url) {
  if (!url) return url;
  return url.replace(/\/QuestBossIcon\/Boss_150\.png$/i, '/QuestBossIcon/BOSS_150.png');
}
