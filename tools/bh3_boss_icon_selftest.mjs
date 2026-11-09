import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixBh3BossIconCase } from '../system/bh3_boss_icons.js';

const icons = JSON.parse(fs.readFileSync(new URL('../resources/bh3_battlefield/boss_icons.json', import.meta.url), 'utf8'));
const moonSoul = icons.bosses['700'];
assert.equal(moonSoul.name, '苍骑士·月魂');
assert.match(moonSoul.avatar, /\/QuestBossIcon\/Boss_130\.png$/);
assert.equal(fixBh3BossIconCase(moonSoul.avatar), moonSoul.avatar);
assert.equal(
  fixBh3BossIconCase('https://example.test/QuestBossIcon/Boss_150.png'),
  'https://example.test/QuestBossIcon/BOSS_150.png',
);

console.log('BH3 boss icon self-test passed');
