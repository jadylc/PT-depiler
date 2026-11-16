import type { ITorrentTag } from "@ptd/site";

import type { ISearchResultTorrent } from "@/shared/types.ts";

/**
 * 跨站聚合：把「同名 + 同大小」的种子归为一组，用于「优先下载站点更多的种子」。
 *
 * 只做保守归一：
 * - 标题忽略大小写、把 . _ - [] 等标点当作空格；
 * - 大小允许 0.2%（不少于 1 MiB）的误差，用于吃掉各站点四舍五入/单位换算的差异；
 * 站点改写标题（加小组名、换中文名）不会被强行合并。
 */

export interface IAggregatedSiteEntry {
  site: string;
  /** 该站点下的全部同组结果（同站可能重复命中） */
  items: ISearchResultTorrent[];
  /** 该站点中最值得下载的一条（做种数最多） */
  best: ISearchResultTorrent;
  count: number;
  seeders: number;
}

export interface IAggregatedGroup {
  key: string;
  title: string;
  size: number;
  sites: IAggregatedSiteEntry[];
  /** 不同站点的数量（同站重复结果只算一个） */
  siteCount: number;
  totalSeeders: number;
  /** 组内最新的发布时间（毫秒） */
  time: number;
  tags: ITorrentTag[];
}

export type TAggregateSortKey = "sites" | "seeders" | "size" | "time" | "title";

export function normalizeTorrentTitle(input: string | undefined | null): string {
  return String(input ?? "")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .toLowerCase()
    .replace(/[\\/|+&,;:!?=~^`'"“”‘’·•。，、；：！？（）【】《》「」]/g, " ")
    .replace(/[._\-\s]+/g, " ")
    .trim();
}

/** 同标题下允许的大小误差 */
export function getSizeTolerance(size: number): number {
  return Math.max(1 << 20, Math.round(Math.abs(size) * 0.002));
}

function toMillis(value: unknown): number {
  const time = Number(value) || 0;
  // 兼容秒 / 毫秒
  return time > 0 && time < 1e11 ? time * 1000 : time;
}

function getTagName(tag: ITorrentTag | string): string {
  return typeof tag === "string" ? tag : (tag?.name ?? "");
}

function buildGroup(normalizedTitle: string, items: ISearchResultTorrent[], size: number): IAggregatedGroup {
  const bySite = new Map<string, IAggregatedSiteEntry>();
  const tagMap = new Map<string, ITorrentTag>();
  let title = "";
  let totalSeeders = 0;
  let time = 0;

  for (const item of items) {
    const site = String(item.site ?? "unknown");
    const seeders = Number(item.seeders) || 0;
    totalSeeders += seeders;
    time = Math.max(time, toMillis(item.time));
    if ((item.title ?? "").length > title.length) title = item.title!;

    for (const tag of item.tags ?? []) {
      const name = getTagName(tag);
      if (name && !tagMap.has(name)) tagMap.set(name, typeof tag === "string" ? { name } : tag);
    }

    const entry = bySite.get(site);
    if (!entry) {
      bySite.set(site, { site, items: [item], best: item, count: 1, seeders });
    } else {
      entry.items.push(item);
      entry.count += 1;
      if (seeders > entry.seeders) {
        entry.best = item;
        entry.seeders = seeders;
      }
    }
  }

  const sites = Array.from(bySite.values()).sort((a, b) => b.seeders - a.seeders);

  return {
    key: `${normalizedTitle}|${Math.round(size)}`,
    title: title || "(untitled)",
    size,
    sites,
    siteCount: sites.length,
    totalSeeders,
    time,
    tags: Array.from(tagMap.values()).slice(0, 6),
  };
}

export function groupSearchResults(items: ISearchResultTorrent[]): IAggregatedGroup[] {
  const byTitle = new Map<string, ISearchResultTorrent[]>();

  for (const item of items) {
    const normalized = normalizeTorrentTitle(item.title || item.subTitle || item.url || "");
    if (!normalized) continue;
    const list = byTitle.get(normalized);
    if (list) list.push(item);
    else byTitle.set(normalized, [item]);
  }

  const groups: IAggregatedGroup[] = [];

  for (const [normalized, list] of byTitle) {
    // 同标题下按大小聚类，容忍站点间的四舍五入差异
    const clusters: { size: number; items: ISearchResultTorrent[] }[] = [];

    for (const item of list) {
      const size = Number(item.size) || 0;
      let target: (typeof clusters)[number] | undefined;

      for (const cluster of clusters) {
        if (size === 0 || cluster.size === 0) {
          if (size === cluster.size) {
            target = cluster;
            break;
          }
          continue;
        }
        if (Math.abs(cluster.size - size) <= getSizeTolerance(size)) {
          target = cluster;
          break;
        }
      }

      if (!target) {
        target = { size, items: [] };
        clusters.push(target);
      }
      target.items.push(item);
    }

    for (const cluster of clusters) {
      groups.push(buildGroup(normalized, cluster.items, cluster.size));
    }
  }

  return groups;
}

const sorters: Record<TAggregateSortKey, (a: IAggregatedGroup, b: IAggregatedGroup) => number> = {
  sites: (a, b) => b.siteCount - a.siteCount || b.totalSeeders - a.totalSeeders || b.size - a.size,
  seeders: (a, b) => b.totalSeeders - a.totalSeeders || b.siteCount - a.siteCount || b.size - a.size,
  size: (a, b) => b.size - a.size || b.siteCount - a.siteCount,
  time: (a, b) => b.time - a.time || b.siteCount - a.siteCount,
  title: (a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"),
};

export function sortAggregatedGroups(groups: IAggregatedGroup[], key: TAggregateSortKey): IAggregatedGroup[] {
  return groups.slice().sort(sorters[key] ?? sorters.sites);
}

/** 站点数徽标的颜色：站点越多越突出 */
export function getSiteCountColor(siteCount: number): string {
  if (siteCount >= 4) return "success";
  if (siteCount === 3) return "primary";
  if (siteCount === 2) return "warning";
  return "grey";
}
