<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useDisplay } from "vuetify";
import { EResultParseStatus, normalizeTorrentPromotion, type ITorrentTag } from "@ptd/site";

import { useMetadataStore } from "@/options/stores/metadata.ts";
import { useConfigStore } from "@/options/stores/config.ts";
import { useRuntimeStore } from "@/options/stores/runtime.ts";
import { formatDate, formatSize, formatTimeAgo } from "@/options/utils.ts";
import type { ISearchResultTorrent } from "@/shared/types.ts";

import SiteName from "@/options/components/SiteName.vue";
import SiteFavicon from "@/options/components/SiteFavicon/Index.vue";

import ActionTd from "./ActionTd.vue";
import QuickFilterNotice from "./QuickFilterNotice.vue";
import SearchStatusDialog from "./SearchStatusDialog.vue";
import SaveSnapshotDialog from "./SaveSnapshotDialog.vue";
import AdvanceFilterGenerateDialog from "./AdvanceFilterGenerateDialog.vue";

import {
  getSiteCountColor,
  groupSearchResults,
  sortAggregatedGroups,
  type IAggregatedGroup,
  type IAggregatedSiteEntry,
  type TAggregateSortKey,
} from "./utils/aggregate";

// 主要助手方法
import { tableCustomFilter } from "./utils/filter";
import { doSearch, retrySearch, searchPlanStatus, searchQueue } from "./utils/search";

const { t } = useI18n();
const route = useRoute();
const configStore = useConfigStore();
const metadataStore = useMetadataStore();
const runtimeStore = useRuntimeStore();
const display = useDisplay();

type TAggregateFilter = "all" | "multi2" | "multi3";

const showAdvanceFilterGenerateDialog = ref<boolean>(false);
const showSearchStatusDialog = ref<boolean>(false);
const showSaveSnapshotDialog = ref<boolean>(false);

/** 聚合视图的排序方式（站点数优先 = 优先展示「更多站点都有」的种子） */
const aggregateSort = ref<TAggregateSortKey>("sites");
/** 聚合视图的站点数筛选 */
const aggregateFilter = ref<TAggregateFilter>("all");
/** 当前展开的分组（key 由 归一化标题 + 大小 组成，结果增量更新时保持展开状态） */
const expandedKeys = ref<Set<string>>(new Set());
/** 已勾选的种子（用 uniqueId 记录，聚合重排 / 分页时不会错位） */
const selectedIds = ref<Set<string>>(new Set());
const aggregatePage = ref(1);

const isSearchingParsed = ref<boolean>(searchQueue.isPaused);

function pauseSearchQueue() {
  console.log("pauseSearchQueue", searchQueue);
  searchQueue.pause();
  isSearchingParsed.value = true;
}

function startSearchQueue() {
  console.log("startSearchQueue", searchQueue);
  searchQueue.start();
  isSearchingParsed.value = false;
}

function cancelSearchQueue() {
  searchQueue.clear(); // 清空搜索队列
  // 将搜索队列中状态设置为跳过
  for (const key of Object.keys(runtimeStore.search.searchPlan)) {
    // @ts-ignore
    if (runtimeStore.search.searchPlan[key]!.status === EResultParseStatus.waiting) {
      // @ts-ignore
      runtimeStore.search.searchPlan[key]!.status = EResultParseStatus.passParse;
      // @ts-ignore
      runtimeStore.search.searchPlan[key]!.statusMsg = "i18n.userCancel";
    }
  }

  runtimeStore.search.isSearching = false;
}

/**
 * 只对「搜索快照」在加载时做一次归一（数据是 sendMessage 回来的普通对象，尚未进入 Pinia store）。
 *
 * 注意：不要在 setup 里对 runtimeStore.search.searchResult 做实时归一 —— runtime store 用
 * sessionStorage 持久化，且每次 mutation 都会触发整份 state 的序列化；逐条改种子会引发
 * N 次全量写入（devtools 里表现为单次 135s 的 RunTask + 大量 setItem）。
 * 实时搜索结果在 offscreen（getSiteSearchResult）阶段已经归一过了，无需重复计算。
 */
function normalizeSnapshotPromotions(items: ISearchResultTorrent[] = []) {
  items.forEach((item) => normalizeTorrentPromotion(item));
}

const sortOptions = computed(() => [
  { title: t("SearchEntity.aggregate.sortSites"), value: "sites" as const },
  { title: t("SearchEntity.aggregate.sortSeeders"), value: "seeders" as const },
  { title: t("SearchEntity.aggregate.sortSize"), value: "size" as const },
  { title: t("SearchEntity.aggregate.sortTime"), value: "time" as const },
  { title: t("SearchEntity.aggregate.sortTitle"), value: "title" as const },
]);

/** 表格筛选（站点、标签、发布状态、时间/大小/做种等范围）同样作用到聚合前的原始结果 */
const { tableFilterRef, tableWaitFilterRef, tableFilterFn, buildAdvanceItemPropsFn, buildFilterDictFn } =
  tableCustomFilter;

const hiddenTagNamesText = computed({
  get: () => configStore.searchEntifyControl.hiddenTagNames.join("\n"),
  set: (val: string) => {
    configStore.searchEntifyControl.hiddenTagNames = val
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  },
});

watch(
  () => route.query,
  (newParams, oldParams) => {
    if (newParams.snapshot) {
      metadataStore.getSearchSnapshotData(newParams.snapshot as string).then((data) => {
        if (data) {
          // 在进入 Pinia store 之前对普通对象做一次归一，避免逐条 mutation 触发 sessionStorage 全量写入
          normalizeSnapshotPromotions(data.searchResult);
          runtimeStore.search = { ...data, snapshot: newParams.snapshot as string };
        }
        // 如果启用了快速站点筛选，则重置一下筛选器，以防止快速站点筛选中无站点数据
        if (configStore.searchEntity.quickSiteFilter) {
          buildAdvanceItemPropsFn();
        }
      });
    } else {
      if (
        newParams.flush ||
        (newParams.search && newParams.search != oldParams?.search) ||
        (newParams.plan && newParams.plan != oldParams?.plan)
      ) {
        // 清理已选择项 （ #622 ）
        selectedIds.value = new Set();
        // doSearch 会自动处理过滤器重置
        doSearch((newParams.search as string) ?? "", (newParams.plan as string) ?? "default", true);
      }
    }
  },
  { immediate: true, deep: true },
);

const filteredItems = computed(() =>
  runtimeStore.search.searchResult.filter((item) => tableFilterFn(item.uniqueId, tableFilterRef.value, { raw: item })),
);

const allGroups = computed(() => groupSearchResults(filteredItems.value));

const multiSiteGroupCount = computed(() => allGroups.value.filter((group) => group.siteCount >= 2).length);

const visibleGroups = computed(() => {
  let groups = allGroups.value;
  if (aggregateFilter.value === "multi2") groups = groups.filter((group) => group.siteCount >= 2);
  else if (aggregateFilter.value === "multi3") groups = groups.filter((group) => group.siteCount >= 3);
  return sortAggregatedGroups(groups, aggregateSort.value);
});

const itemsPerPage = computed(() => configStore.tableBehavior.SearchEntity.itemsPerPage || 50);

const pageCount = computed(() => Math.max(1, Math.ceil(visibleGroups.value.length / itemsPerPage.value)));

const pagedGroups = computed(() => {
  const start = (aggregatePage.value - 1) * itemsPerPage.value;
  return visibleGroups.value.slice(start, start + itemsPerPage.value);
});

const selectedTorrents = computed<ISearchResultTorrent[]>(() =>
  runtimeStore.search.searchResult.filter((item) => selectedIds.value.has(item.uniqueId)),
);

watch([aggregateFilter, aggregateSort, tableFilterRef, itemsPerPage], () => {
  aggregatePage.value = 1;
});

watch(pageCount, (count) => {
  if (aggregatePage.value > count) aggregatePage.value = count;
});

// ---------------------------------------------------------------------------
// 选择 / 展开
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

function toggleGroupSelection(group: IAggregatedGroup) {
  const next = new Set(selectedIds.value);
  const selectAll = !isGroupSelected(group);
  for (const entry of group.sites) {
    for (const item of entry.items) {
      if (selectAll) next.add(item.uniqueId);
      else next.delete(item.uniqueId);
    }
  }
  selectedIds.value = next;
}

function toggleItemSelection(item: ISearchResultTorrent) {
  const next = new Set(selectedIds.value);
  if (next.has(item.uniqueId)) next.delete(item.uniqueId);
  else next.add(item.uniqueId);
  selectedIds.value = next;
}

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

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/** 组内展示的标签：尊重「显示标签」开关、隐藏标签名单与最大数量设置 */
function visibleTags(tags: ITorrentTag[] = [], maxCount = 3): ITorrentTag[] {
  if (!configStore.searchEntifyControl.showTorrentTag) return [];
  const hidden = configStore.searchEntifyControl.hiddenTagNames ?? [];
  const limit = maxCount > 0 ? maxCount : 3;
  return tags.filter((tag) => tag?.name && !hidden.includes(tag.name)).slice(0, limit);
}

function formatTorrentTime(time?: number): string {
  if (!time) return "-";
  return configStore.searchEntifyControl.uploadAtFormatAsAlive ? formatTimeAgo(time) : formatDate(time, "yyyy-MM-dd");
}

function getFirstSiteLink(group: IAggregatedGroup): string {
  return group.sites[0]?.best.url ?? "";
}

function onDownloadButtonClick(event: MouseEvent) {
  // 站内链接都在新标签打开，避免把聚合页面顶掉
  event.stopPropagation();
}
</script>

<template>
  <v-alert type="info">
    <v-alert-title>
      <template v-if="runtimeStore.search.startAt === 0">
        {{ t("SearchEntity.index.alert.enterKeyword") }}
      </template>
      <template v-else>
        <template v-if="runtimeStore.search.isSearching">
          <template v-if="isSearchingParsed">
            {{ t("SearchEntity.index.alert.paused") }}
          </template>
          <template v-else>
            <template v-if="runtimeStore.search.searchResult.length > 0">
              {{ t("SearchEntity.index.alert.plan") }}
              [{{ metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey) }}]，
              {{ t("SearchEntity.index.alert.keyword") }}
              [{{ runtimeStore.search.searchKey }}]，
              {{ t("SearchEntity.index.alert.searchProgress", [runtimeStore.search.searchResult.length]) }}
            </template>
            <template v-else>
              {{ t("SearchEntity.index.alert.searching") }}
            </template>
          </template>
        </template>
        <template v-else>
          <template v-if="runtimeStore.search.snapshot">
            {{ t("SearchEntity.index.alert.snapshot") }}
            [{{ metadataStore.snapshots[runtimeStore.search.snapshot].name }}]，
          </template>
          <template v-else>
            {{ t("SearchEntity.index.alert.plan") }}
            [{{ metadataStore.getSearchSolutionName(runtimeStore.search.searchPlanKey) }}]，
          </template>
          {{ t("SearchEntity.index.alert.keyword") }}
          [{{ runtimeStore.search.searchKey }}]，
          {{ t("SearchEntity.index.alert.results", [runtimeStore.search.searchResult.length]) }}
          {{ t("SearchEntity.index.alert.duration", [(runtimeStore.searchCostTime / 1000).toFixed(1)]) }}
        </template>

        <v-spacer />

        <v-btn
          :title="t('SearchEntity.index.alert.searchStatus')"
          class="mr-2 status-btn"
          color="primary"
          size="small"
          @click="showSearchStatusDialog = true"
        >
          <template v-if="searchPlanStatus.success > 0">
            <v-icon class="mr-1" icon="mdi-check" size="x-small" />{{ searchPlanStatus.success }}
          </template>
          <template v-if="searchPlanStatus.error > 0">
            <v-icon class="mr-1" color="amber" icon="mdi-alert" size="x-small" />{{ searchPlanStatus.error }}
          </template>
          <template v-if="searchPlanStatus.queued > 0">
            <v-icon class="mr-1" color="blue-grey" icon="mdi-clock" size="x-small" />{{ searchPlanStatus.queued }}
          </template>
        </v-btn>
      </template>
    </v-alert-title>
  </v-alert>

  <v-card>
    <v-card-title>
      <v-row gap="0" class="ma-0 align-center">
        <!-- 不指定 size：Vuetify 4 下图标按钮为 (--v-btn-height + 12px) 的正方形（48 × 48），与 ActionTd 保持一致 -->
        <v-btn-group variant="text">
          <!-- 启动/暂停 搜索队列 -->
          <v-btn
            v-show="isSearchingParsed"
            :title="t('SearchEntity.index.action.start')"
            color="success"
            icon="mdi-play"
            @click="() => startSearchQueue()"
          />
          <v-btn
            v-show="!isSearchingParsed"
            :title="t('SearchEntity.index.action.pause')"
            color="success"
            icon="mdi-pause"
            @click="() => pauseSearchQueue()"
          />

          <!-- 取消/重试 搜索队列 -->
          <v-btn
            v-show="runtimeStore.search.isSearching"
            :title="t('SearchEntity.index.action.cancel')"
            color="red"
            icon="mdi-cancel"
            @click="cancelSearchQueue"
          />
          <v-btn
            v-show="!runtimeStore.search.isSearching"
            :disabled="isSearchingParsed"
            :title="t('SearchEntity.index.action.retry')"
            color="red"
            icon="mdi-sync"
            @click="() => doSearch(null as unknown as string, null as unknown as string, true)"
          />

          <!-- 重试失败的搜索 -->
          <v-btn
            :disabled="searchPlanStatus.error === 0"
            :title="t('SearchEntity.index.action.retryFailed')"
            color="amber"
            icon="mdi-sync-alert"
            @click="() => retrySearch()"
          />

          <v-divider vertical class="mx-2" />

          <!-- 创建搜索快照 -->
          <v-btn
            :disabled="runtimeStore.search.isSearching || runtimeStore.search.searchResult.length === 0"
            :title="t('SearchEntity.index.action.saveSnapshot')"
            color="cyan"
            icon="mdi-camera-plus"
            @click="showSaveSnapshotDialog = true"
          ></v-btn>
        </v-btn-group>

        <v-divider vertical class="mx-2" />

        <!-- 批量操作（下载 / 辅种 / 收藏）作用于勾选的种子 -->
        <ActionTd :torrent-items="selectedTorrents" />

        <v-divider vertical class="mx-2" />

        <!-- 显示偏好：聚合视图下只有「标签」与「时间格式」还起作用 -->
        <v-menu :close-on-content-click="false">
          <template v-slot:activator="{ props }">
            <v-btn-group variant="text">
              <v-btn
                :title="t('SearchEntity.index.action.displayPreferences')"
                color="blue"
                icon="mdi-cog"
                v-bind="props"
              />
            </v-btn-group>
          </template>
          <v-list>
            <v-list-item>
              <template v-slot:prepend>
                <v-list-item-action start class="ml-2">
                  <v-switch
                    v-model="configStore.searchEntifyControl.showTorrentTag"
                    :label="`&nbsp;${t('SearchEntity.index.showTorrentTag')}`"
                    color="success"
                    density="compact"
                    hide-details
                    @click.stop
                    @update:model-value="() => configStore.$save()"
                  />
                </v-list-item-action>
              </template>
            </v-list-item>
            <v-list-item>
              <template v-slot:prepend>
                <v-list-item-action start class="ml-2">
                  <v-switch
                    v-model="configStore.searchEntifyControl.uploadAtFormatAsAlive"
                    :label="`&nbsp;${t('SearchEntity.index.uploadAtFormatAsAlive')}`"
                    color="success"
                    density="compact"
                    hide-details
                    @click.stop
                    @update:model-value="() => configStore.$save()"
                  />
                </v-list-item-action>
              </template>
            </v-list-item>
            <v-list-item v-if="configStore.searchEntifyControl.showTorrentTag" class="mt-2">
              <v-textarea
                v-model="hiddenTagNamesText"
                :label="t('SetBase.searchEntity.hiddenTagNames')"
                hide-details
                clearable
                rows="5"
              />
            </v-list-item>
          </v-list>
        </v-menu>

        <v-divider vertical class="mx-2" />

        <!-- 聚合排序 / 站点数筛选 / 展开收起 -->
        <v-select
          v-model="aggregateSort"
          :items="sortOptions"
          density="compact"
          hide-details
          max-width="150"
          prepend-inner-icon="mdi-sort"
          :title="t('SearchEntity.aggregate.sort')"
        />

        <v-btn-toggle
          :model-value="aggregateFilter"
          class="ml-2"
          density="compact"
          divided
          mandatory
          variant="outlined"
          @update:model-value="(value) => (aggregateFilter = (value ?? 'all') as TAggregateFilter)"
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
        <v-text-field
          v-model="tableWaitFilterRef"
          append-icon="mdi-magnify"
          clearable
          density="compact"
          hide-details
          :label="t('SearchEntity.index.filterLabel')"
          max-width="500"
          prepend-inner-icon="mdi-filter"
          single-line
          @click:prepend-inner="showAdvanceFilterGenerateDialog = true"
          @update:model-value="(val) => buildFilterDictFn(val)"
        />
      </v-row>
    </v-card-title>

    <v-card-text class="pt-2 pb-0">
      <!-- 站点筛选器、已选种子等提示信息 -->
      <QuickFilterNotice :selected-torrents="selectedTorrents" />

      <div class="agg-summary d-flex align-center ga-4 px-1 py-2 text-body-small text-medium-emphasis">
        <span>
          {{ t("SearchEntity.aggregate.summary", [visibleGroups.length, filteredItems.length, multiSiteGroupCount]) }}
        </span>
        <v-spacer />
        <span v-if="pageCount > 1">{{ t("SearchEntity.aggregate.page", [aggregatePage, pageCount]) }}</span>
      </div>

      <div class="agg-list">
        <div
          v-for="group in pagedGroups"
          :key="group.key"
          class="agg-group"
          :class="{ 'agg-group--multi': group.siteCount >= 2 }"
        >
          <div class="agg-head" @click="toggleExpanded(group.key)">
            <v-checkbox-btn
              :indeterminate="isGroupIndeterminate(group)"
              :model-value="isGroupSelected(group)"
              class="flex-0-0"
              density="compact"
              hide-details
              :title="t('SearchEntity.aggregate.selectGroup')"
              @click.stop
              @update:model-value="() => toggleGroupSelection(group)"
            />

            <v-chip :color="getSiteCountColor(group.siteCount)" class="agg-badge" label size="small">
              {{ t("SearchEntity.aggregate.siteCount", [group.siteCount]) }}
            </v-chip>

            <a
              :href="getFirstSiteLink(group)"
              :title="group.title"
              class="agg-title text-body-large text-high-emphasis text-decoration-none text-truncate"
              rel="noopener noreferrer nofollow"
              target="_blank"
              @click.stop
            >
              {{ group.title }}
            </a>

            <div class="agg-tags">
              <v-chip v-for="tag in visibleTags(group.tags)" :key="tag.name" :color="tag.color" label size="x-small">
                {{ tag.name }}
              </v-chip>
            </div>

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
                <SiteName :site-id="entry.site" class="text-body-medium" tag="span" />
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
              <span v-if="!display.smAndDown.value" class="agg-time">
                {{ formatTorrentTime(entry.best.time) }}
              </span>

              <div class="agg-tags">
                <v-chip
                  v-for="tag in visibleTags(entry.best.tags ?? [], 3)"
                  :key="tag.name"
                  :color="tag.color"
                  label
                  size="x-small"
                >
                  {{ tag.name }}
                </v-chip>
              </div>

              <div class="agg-site-actions" @click.stop="onDownloadButtonClick">
                <ActionTd :torrent-items="[entry.best]" density="compact" :show-keep-upload-btn="false" />
              </div>
            </div>
          </div>
        </div>

        <v-alert v-if="!pagedGroups.length" class="ma-1" type="info" variant="tonal">
          {{ t("SearchEntity.aggregate.empty") }}
        </v-alert>
      </div>

      <div v-if="pageCount > 1" class="d-flex justify-center py-3">
        <v-pagination v-model="aggregatePage" :length="pageCount" :total-visible="7" density="comfortable" />
      </div>
    </v-card-text>
  </v-card>

  <AdvanceFilterGenerateDialog v-model="showAdvanceFilterGenerateDialog" />
  <SearchStatusDialog v-model="showSearchStatusDialog" />
  <SaveSnapshotDialog v-model="showSaveSnapshotDialog" />
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

.agg-badge {
  flex: 0 0 auto;
  min-width: 52px;
  justify-content: center;
}

.agg-title {
  flex: 1 1 auto;
  min-width: 0;
}

.agg-tags {
  display: flex;
  flex: 0 0 auto;
  gap: 4px;
  max-width: 35%;
  overflow: hidden;
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

.agg-check {
  display: flex;
  align-items: center;
  justify-content: center;
}

.agg-site {
  display: grid;
  grid-template-columns: 32px minmax(120px, 170px) 52px 52px 52px 86px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 2px;

  &:hover {
    background: rgba(var(--v-theme-on-surface), 0.03);
  }

  &--compact {
    grid-template-columns: 32px minmax(100px, 150px) 48px 48px minmax(0, 1fr) auto;
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

.agg-site-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
