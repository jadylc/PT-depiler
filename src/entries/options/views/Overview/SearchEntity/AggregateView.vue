<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useDisplay } from "vuetify";
import type { ITorrentTag } from "@ptd/site";

import { useConfigStore } from "@/options/stores/config.ts";
import { formatDate, formatSize, formatTimeAgo } from "@/options/utils.ts";
import type { ISearchResultTorrent } from "@/shared/types.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";

import ActionTd from "./ActionTd.vue";
import {
  getSiteCountColor,
  groupSearchResults,
  sortAggregatedGroups,
  type IAggregatedGroup,
  type IAggregatedSiteEntry,
  type TAggregateSortKey,
} from "./utils/aggregate";

/**
 * 搜索结果聚合视图（可选功能）：
 * 把「同名 + 同大小」的种子合并成一组，按站点数排序，展开后挑选站点下载。
 *
 * 作为独立组件挂在 Index.vue 上，聚合开关关闭时完全不渲染，便于与上游代码合并。
 */
const props = defineProps<{
  /** 已应用「站点筛选 / 高级筛选」后的搜索结果 */
  items: ISearchResultTorrent[];
  /** 已勾选的种子（与列表视图共用同一份选择，便于顶部批量操作） */
  selected: ISearchResultTorrent[];
}>();

const emit = defineEmits<{
  (e: "update:selected", value: ISearchResultTorrent[]): void;
}>();

const { t } = useI18n();
const configStore = useConfigStore();
const display = useDisplay();

type TAggregateFilter = "all" | "multi2" | "multi3";

const sortKey = ref<TAggregateSortKey>("sites");
const siteFilter = ref<TAggregateFilter>("all");
const expandedKeys = ref<Set<string>>(new Set());
const page = ref(1);

const sortOptions = computed(() => [
  { title: t("SearchEntity.aggregate.sortSites"), value: "sites" as const },
  { title: t("SearchEntity.aggregate.sortSeeders"), value: "seeders" as const },
  { title: t("SearchEntity.aggregate.sortSize"), value: "size" as const },
  { title: t("SearchEntity.aggregate.sortTime"), value: "time" as const },
  { title: t("SearchEntity.aggregate.sortTitle"), value: "title" as const },
]);

const allGroups = computed(() => groupSearchResults(props.items));

const multiSiteGroupCount = computed(() => allGroups.value.filter((group) => group.siteCount >= 2).length);

const visibleGroups = computed(() => {
  let groups = allGroups.value;
  if (siteFilter.value === "multi2") groups = groups.filter((group) => group.siteCount >= 2);
  else if (siteFilter.value === "multi3") groups = groups.filter((group) => group.siteCount >= 3);
  return sortAggregatedGroups(groups, sortKey.value);
});

const itemsPerPage = computed(() => configStore.tableBehavior.SearchEntity.itemsPerPage || 50);

const pageCount = computed(() => Math.max(1, Math.ceil(visibleGroups.value.length / itemsPerPage.value)));

const pagedGroups = computed(() => {
  const start = (page.value - 1) * itemsPerPage.value;
  return visibleGroups.value.slice(start, start + itemsPerPage.value);
});

const selectedIds = computed(() => new Set(props.selected.map((item) => item.uniqueId)));

watch([siteFilter, sortKey, itemsPerPage], () => {
  page.value = 1;
});

watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

/** 聚合结果变化后，清掉已经不存在的展开项 */
watch(allGroups, (groups) => {
  const keys = new Set(groups.map((group) => group.key));
  const next = new Set(Array.from(expandedKeys.value).filter((key) => keys.has(key)));
  if (next.size !== expandedKeys.value.size) expandedKeys.value = next;
});

// ---------------------------------------------------------------------------
// 选择
// ---------------------------------------------------------------------------

function isItemSelected(item: ISearchResultTorrent): boolean {
  return selectedIds.value.has(item.uniqueId);
}

function getGroupSelectedCount(group: IAggregatedGroup): { selected: number; total: number } {
  let selected = 0;
  let total = 0;
  for (const entry of group.sites) {
    for (const item of entry.items) {
      total += 1;
      if (selectedIds.value.has(item.uniqueId)) selected += 1;
    }
  }
  return { selected, total };
}

function isGroupSelected(group: IAggregatedGroup): boolean {
  const { selected, total } = getGroupSelectedCount(group);
  return total > 0 && selected === total;
}

function isGroupIndeterminate(group: IAggregatedGroup): boolean {
  const { selected, total } = getGroupSelectedCount(group);
  return selected > 0 && selected < total;
}

function applySelection(mutate: (ids: Set<string>) => void) {
  const ids = new Set(selectedIds.value);
  mutate(ids);
  emit(
    "update:selected",
    props.items.filter((item) => ids.has(item.uniqueId)),
  );
}

function toggleGroupSelection(group: IAggregatedGroup) {
  const selectAll = !isGroupSelected(group);
  applySelection((ids) => {
    for (const entry of group.sites) {
      for (const item of entry.items) {
        if (selectAll) ids.add(item.uniqueId);
        else ids.delete(item.uniqueId);
      }
    }
  });
}

function toggleItemSelection(item: ISearchResultTorrent) {
  applySelection((ids) => {
    if (ids.has(item.uniqueId)) ids.delete(item.uniqueId);
    else ids.add(item.uniqueId);
  });
}

// ---------------------------------------------------------------------------
// 展开 / 跳转
// ---------------------------------------------------------------------------

function toggleExpanded(key: string) {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedKeys.value = next;
}

function expandAllVisible() {
  expandedKeys.value = new Set(pagedGroups.value.map((group) => group.key));
}

function collapseAll() {
  expandedKeys.value = new Set();
}

/** 只有点到具体站点才跳转；点分组标题只负责展开/收起 */
function openSiteDetail(entry: IAggregatedSiteEntry) {
  const url = entry.best.url || entry.best.link;
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

/** 站点行标签：不再截断（只受「显示标签」开关与隐藏标签名单影响） */
function visibleTags(tags: ITorrentTag[] = []): ITorrentTag[] {
  if (!configStore.searchEntifyControl.showTorrentTag) return [];
  const hidden = configStore.searchEntifyControl.hiddenTagNames ?? [];
  return tags.filter((tag) => tag?.name && !hidden.includes(tag.name));
}

function formatTorrentTime(time?: number): string {
  if (!time) return "-";
  return configStore.searchEntifyControl.uploadAtFormatAsAlive ? formatTimeAgo(time) : formatDate(time, "yyyy-MM-dd");
}
</script>

<template>
  <div class="agg-wrap">
    <div class="agg-toolbar d-flex align-center flex-wrap ga-2 py-1">
      <v-select
        v-model="sortKey"
        :items="sortOptions"
        density="compact"
        hide-details
        max-width="150"
        prepend-inner-icon="mdi-sort"
        :title="t('SearchEntity.aggregate.sort')"
      />

      <v-btn-toggle
        :model-value="siteFilter"
        density="compact"
        divided
        mandatory
        variant="outlined"
        @update:model-value="(value) => (siteFilter = (value ?? 'all') as TAggregateFilter)"
      >
        <v-btn size="small" value="all">{{ t("SearchEntity.aggregate.filterAll") }}</v-btn>
        <v-btn size="small" value="multi2">{{ t("SearchEntity.aggregate.filterMulti") }}</v-btn>
        <v-btn size="small" value="multi3">{{ t("SearchEntity.aggregate.filterMulti3") }}</v-btn>
      </v-btn-toggle>

      <v-btn-group variant="text">
        <v-btn
          :title="t('SearchEntity.aggregate.expandAll')"
          icon="mdi-arrow-expand-vertical"
          size="small"
          @click="expandAllVisible"
        />
        <v-btn
          :title="t('SearchEntity.aggregate.collapseAll')"
          icon="mdi-arrow-collapse-vertical"
          size="small"
          @click="collapseAll"
        />
      </v-btn-group>

      <v-spacer />

      <span class="text-body-small text-medium-emphasis">
        {{ t("SearchEntity.aggregate.summary", [visibleGroups.length, props.items.length, multiSiteGroupCount]) }}
      </span>
      <span v-if="pageCount > 1" class="text-body-small text-medium-emphasis">
        {{ t("SearchEntity.aggregate.page", [page, pageCount]) }}
      </span>
    </div>

    <div class="agg-list">
      <div
        v-for="group in pagedGroups"
        :key="group.key"
        class="agg-group"
        :class="{ 'agg-group--multi': group.siteCount >= 2 }"
      >
        <!-- 标题只负责展开/收起；跳转在下面的具体站点行里 -->
        <div class="agg-head" @click="toggleExpanded(group.key)">
          <div class="agg-check" @click.stop>
            <v-checkbox-btn
              :indeterminate="isGroupIndeterminate(group)"
              :model-value="isGroupSelected(group)"
              density="compact"
              hide-details
              :title="t('SearchEntity.aggregate.selectGroup')"
              @update:model-value="() => toggleGroupSelection(group)"
            />
          </div>

          <v-chip :color="getSiteCountColor(group.siteCount)" class="agg-badge" label size="small">
            {{ t("SearchEntity.aggregate.siteCount", [group.siteCount]) }}
          </v-chip>

          <span class="agg-title text-body-large text-high-emphasis text-truncate" :title="group.title">
            {{ group.title }}
          </span>

          <v-spacer />
          <span class="agg-size">{{ formatSize(group.size) }}</span>
          <span class="agg-seeders text-success" :title="t('SearchEntity.index.table.seeders')">
            ↑{{ group.totalSeeders }}
          </span>
          <v-icon :icon="expandedKeys.has(group.key) ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="small" />
        </div>

        <div v-if="expandedKeys.has(group.key)" class="agg-sites">
          <div
            v-for="entry in group.sites"
            :key="entry.site"
            class="agg-site"
            :class="{ 'agg-site--compact': display.smAndDown.value }"
            :title="t('SearchEntity.aggregate.openSite')"
            @click="openSiteDetail(entry)"
          >
            <!-- 包一层容器：Vuetify 的 .v-selection-control 带有 grid 命名区，直接作为 grid 子项会被摆到行尾 -->
            <div class="agg-check" @click.stop>
              <v-checkbox-btn
                :model-value="isItemSelected(entry.best)"
                density="compact"
                hide-details
                :title="t('SearchEntity.aggregate.selectSite')"
                @update:model-value="() => toggleItemSelection(entry.best)"
              />
            </div>

            <div class="agg-site-name">
              <SiteFavicon :site-id="entry.site" :size="16" />
              <SiteName :site-id="entry.site" class="text-body-medium agg-site-label" tag="span" />
              <v-chip v-if="entry.count > 1" size="x-small" variant="text">×{{ entry.count }}</v-chip>
            </div>

            <span class="agg-num text-success" :title="t('SearchEntity.index.table.seeders')">
              ↑{{ entry.best.seeders }}
            </span>
            <span class="agg-num text-error" :title="t('SearchEntity.index.table.leechers')">
              ↓{{ entry.best.leechers }}
            </span>
            <span v-if="!display.smAndDown.value" class="agg-num" :title="t('SearchEntity.index.table.completed')">
              {{ entry.best.completed }}
            </span>
            <span v-if="!display.smAndDown.value" class="agg-time">{{ formatTorrentTime(entry.best.time) }}</span>

            <div class="agg-tags">
              <v-chip
                v-for="tag in visibleTags(entry.best.tags ?? [])"
                :key="tag.name"
                :color="tag.color"
                label
                size="x-small"
              >
                {{ tag.name }}
              </v-chip>
            </div>

            <div class="agg-site-actions" @click.stop>
              <ActionTd :torrent-items="[entry.best]" density="compact" :show-keep-upload-btn="false" />
            </div>
          </div>
        </div>
      </div>

      <v-alert v-if="!pagedGroups.length" class="ma-1" type="info" variant="tonal">
        {{ t("SearchEntity.aggregate.empty") }}
      </v-alert>
    </div>

    <div v-if="pageCount > 1" class="d-flex justify-center py-2">
      <v-pagination v-model="page" :length="pageCount" :total-visible="7" density="comfortable" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.agg-list {
  padding-bottom: 8px;
}

.agg-group {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 8px;
  margin-bottom: 6px;
  overflow: hidden;

  &--multi {
    border-left: 3px solid rgb(var(--v-theme-success));
  }
}

.agg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  cursor: pointer;

  &:hover {
    background: rgba(var(--v-theme-on-surface), 0.04);
  }
}

.agg-check {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
}

.agg-badge {
  flex: 0 0 auto;
  min-width: 52px;
  justify-content: center;
}

.agg-title {
  flex: 1 1 auto;
  min-width: 0;
}

.agg-size {
  flex: 0 0 auto;
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 12px;
  white-space: nowrap;
}

.agg-seeders {
  flex: 0 0 auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.agg-sites {
  border-top: 1px dashed rgba(var(--v-theme-on-surface), 0.12);
}

.agg-site {
  display: grid;
  grid-template-columns: 32px minmax(120px, 170px) 52px 52px 52px 86px minmax(60px, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 2px 8px 2px 2px;
  cursor: pointer;

  &:hover {
    background: rgba(var(--v-theme-on-surface), 0.04);
  }

  &:hover .agg-site-label {
    text-decoration: underline;
  }

  &--compact {
    grid-template-columns: 32px minmax(100px, 150px) 48px 48px minmax(60px, 1fr) auto;
  }
}

.agg-site-name {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.agg-site-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.agg-num {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.agg-time {
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 12px;
  white-space: nowrap;
}

.agg-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  min-width: 0;
}

.agg-site-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
