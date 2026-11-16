import assert from "node:assert/strict";

import {
  getSiteCountColor,
  groupSearchResults,
  sortAggregatedGroups,
} from "../../src/entries/options/views/Overview/SearchEntity/utils/aggregate.ts";

const GiB = 1024 ** 3;

const item = (site: string, id: number, title: string, size: number, seeders = 0, time = 1714521600000) => ({
  site,
  id,
  title,
  size,
  seeders,
  leechers: 1,
  completed: 1,
  time,
  url: `https://${site}.example/t/${id}`,
  link: `https://${site}.example/dl/${id}`,
  tags: [{ name: "免费" }],
  uniqueId: `${site}-${id}`,
});

// 同名同大小跨 3 站 → 1 组 / 3 站
const groups = groupSearchResults([
  item("alpha", 1, "Some.Movie.2024.1080p.BluRay.x264-GROUP", 8 * GiB, 12),
  item("beta", 2, "Some Movie 2024 1080p BluRay x264 GROUP", 8 * GiB, 31),
  item("gamma", 3, "Some.Movie.2024.1080p.BluRay.x264-GROUP", 8 * GiB, 5),
  item("alpha", 4, "Another.Show.S01E01.1080p.WEB-DL", 2 * GiB, 8),
  item("beta", 5, "Another.Show.S01E01.1080p.WEB-DL", 2 * GiB, 9),
]);

assert.equal(groups.length, 2);
const movie = groups.find((g) => g.title.startsWith("Some.Movie"))!;
assert.equal(movie.siteCount, 3);
assert.equal(movie.totalSeeders, 48);
assert.deepEqual(
  movie.sites.map((s) => s.site),
  ["beta", "alpha", "gamma"],
);

// 同标题但大小差 100MiB（超过 0.2% 容差）→ 不合并
assert.equal(
  groupSearchResults([
    item("alpha", 1, "Same.Title.2024.1080p", 8 * GiB),
    item("beta", 2, "Same.Title.2024.1080p", 8 * GiB + 100 * 1024 * 1024),
  ]).length,
  2,
);

// 同标题、大小只差 4MiB → 合并
assert.equal(
  groupSearchResults([
    item("alpha", 1, "Same.Title.2024.1080p", 8 * GiB),
    item("beta", 2, "Same.Title.2024.1080p", 8 * GiB + 4 * 1024 * 1024),
  ]).length,
  1,
);

// 同站重复命中 → 站点数不重复计
const dup = groupSearchResults([
  item("alpha", 1, "Dup.Title.2024", GiB, 1),
  item("alpha", 2, "Dup.Title.2024", GiB, 7),
]);
assert.equal(dup[0].siteCount, 1);
assert.equal(dup[0].sites[0].count, 2);
assert.equal(dup[0].sites[0].best.id, 2);

// 默认排序：站点数多的在前
const sorted = sortAggregatedGroups(groups, "sites");
assert.equal(sorted[0].siteCount, 3);
assert.equal(getSiteCountColor(4), "success");
assert.equal(getSiteCountColor(1), "grey");

console.log("aggregate.ts 逻辑检查通过");
