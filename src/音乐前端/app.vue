<template>
  <!-- [修改点] V9.1 - 新增根节点，用于解耦音量条与主容器的布局 -->
  <div class="player-root">
    <div
      class="aria-pod-container"
      :class="{
        'is-ready': isReadyToShow,
        'is-playlist-open': isPlaylistVisible,
        'is-transitioning': isTransitioning,
      }"
      @click="handleClickOutside"
    >
      <div class="player-content-wrapper">
        <!-- "Aria Pod" 主界面 -->
        <div v-if="!initializationError" class="player-main">
          <!-- 1. 当前曲目区 (Track Info) -->
          <div class="track-info">
            <img v-if="currentItem?.cover" :src="currentItem.cover" alt="封面" class="cover-art" />
            <div v-else class="cover-art cover-art-placeholder">
              <i class="fa-solid fa-music"></i>
            </div>
            <div class="details">
              <p class="title" :title="currentItem?.title">{{ currentItem?.title || '歌单未配置' }}</p>
              <p class="artist" :title="currentItem?.artist">{{ currentItem?.artist || '未知艺术家' }}</p>
            </div>
          </div>

          <!-- 2. 核心控制区 (Playback Controls) -->
          <div class="controls">
            <button
              ref="modeButtonRef"
              class="control-btn"
              title="切换播放模式 (轻点) / 打开列表 (长按)"
              @click.prevent="cyclePlaybackMode"
            >
              <i
                class="fa-solid"
                :class="{
                  'fa-list-ul': playbackMode === 'list',
                  'fa-shuffle': playbackMode === 'random',
                  'fa-repeat': playbackMode === 'single',
                }"
              ></i>
            </button>
            <div class="main-controls">
              <button class="control-btn" title="上一首" @click="playPrev">
                <i class="fa-solid fa-backward-step"></i>
              </button>
              <button class="control-btn play-pause-btn" :title="isPlaying ? '暂停' : '播放'" @click="togglePlayPause">
                <i :class="isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play'"></i>
              </button>
              <button class="control-btn" title="下一首" @click="playNext">
                <i class="fa-solid fa-forward-step"></i>
              </button>
            </div>
            <div class="volume-control-wrapper">
              <button class="control-btn volume-btn" title="音量" @click.stop="toggleVolume">
                <i class="fa-solid fa-volume-high"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- 3. 播放列表抽屉 (Playlist Drawer) -->
        <div class="playlist-drawer">
          <ul class="playlist">
            <li
              v-for="(item, index) in playlist"
              :key="`${item.title}-${index}`"
              :class="{ active: index === activeIndex }"
              :title="`播放: ${item.title}`"
              @click="playIndex(index)"
            >
              <span class="index">{{ index + 1 }}</span>
              <span class="title">{{ item.title }}</span>
              <span class="artist">{{ item.artist }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- [修改点] V9.1 - 音量滑块现在是根节点的子元素，与主容器是兄弟关系 -->
    <div v-if="isVolumeVisible" class="volume-slider-container" @click.stop>
      <div ref="volumeTrackRef" class="custom-volume-slider" @mousedown.prevent.stop="startVolumeDrag">
        <div class="track">
          <div class="progress" :style="{ height: `${masterVolume * 100}%` }"></div>
        </div>
        <div class="thumb" :style="{ bottom: `calc(${masterVolume * 100}% - 4px)` }"></div>
      </div>
    </div>

    <!-- 初始化错误提示 (无变化) -->
    <div v-if="initializationError" class="error-overlay">
      <p><i class="fa-solid fa-triangle-exclamation"></i> 播放器加载失败</p>
      <small>{{ initializationError }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onLongPress } from '@vueuse/core';
import { onMounted, onUnmounted, ref } from 'vue';

// --- 状态与引用 ---
const isPlaylistVisible = ref(false);
const isVolumeVisible = ref(false);
const volumeTrackRef = ref<HTMLElement | null>(null);
const modeButtonRef = ref<HTMLElement | null>(null);

// [新增] 用于区分长按和轻点的“信号旗”
const isLongPressJustFinished = ref(false);

const log = (message: string) => console.log(`[播放器前端] ${message}`);

type PlaybackMode = 'list' | 'single' | 'random';
type PlaylistItem = { title: string; artist?: string; cover?: string };
type FullStatePayload = {
  currentItem: { title: string; artist?: string; cover?: string } | null;
  isPlaying: boolean;
  playbackMode: PlaybackMode;
  masterVolume: number;
  playlist: PlaylistItem[];
  isTransitioning: boolean;
};
type TimeUpdatePayload = { currentTime: number; duration: number };
interface MusicPlayerAPI {
  requestInitialization: () => Promise<void>;
  togglePlayPause: () => void;
  playNext: () => void;
  playPrev: () => void;
  playIndex: (index: number) => void;
  persistVolumeAndBroadcast: (volume: number) => void;
  setLiveVolume: (volume: number) => void;
  seekTo: (percentage: number) => void;
  setPlaybackMode: (mode: PlaybackMode) => void;
  getCurrentState: () => FullStatePayload;
  onFullStateUpdate: (callback: (payload: FullStatePayload) => void) => () => void;
  onTimeUpdate: (callback: (payload: TimeUpdatePayload) => void) => () => void;
}

const musicPlayerAPI = ref<MusicPlayerAPI | null>(null);
let unregisterStateListener: (() => void) | null = null;
const initializationError = ref<string | null>(null);
const isReadyToShow = ref(false);
const isPlaying = ref(false);
const isTransitioning = ref(false);
const currentItem = ref<{ title: string; artist?: string; cover?: string } | null>(null);
const playlist = ref<PlaylistItem[]>([]);
const masterVolume = ref(0.5);
const activeIndex = ref(-1);
const playbackMode = ref<PlaybackMode>('list');

// --- 核心交互逻辑 ---

const cyclePlaybackMode = () => {
  // [修改] 增加“信号旗”检查逻辑
  if (isLongPressJustFinished.value) {
    isLongPressJustFinished.value = false; // 放下信号旗
    log('“轻点”事件被抑制，因为它是一次长按的结束。');
    return; // 阻止后续的模式切换逻辑
  }

  const modes: PlaybackMode[] = ['list', 'random', 'single'];
  const currentIndex = modes.indexOf(playbackMode.value);
  const nextIndex = (currentIndex + 1) % modes.length;
  const nextMode = modes[nextIndex];
  musicPlayerAPI.value?.setPlaybackMode(nextMode);
};

onLongPress(
  modeButtonRef,
  () => {
    isPlaylistVisible.value = !isPlaylistVisible.value;
    if (isPlaylistVisible.value) isVolumeVisible.value = false;
    log('长按触发：切换播放列表显示。');

    // [修改] 升起“信号旗”，标记刚刚完成了一次长按
    isLongPressJustFinished.value = true;
    log('长按已处理，设置“轻点”抑制信号旗。');
  },
  { delay: 400 },
);

const toggleVolume = () => {
  isVolumeVisible.value = !isVolumeVisible.value;
  if (isVolumeVisible.value) isPlaylistVisible.value = false;
};

const handleClickOutside = () => {
  if (isVolumeVisible.value) {
    isVolumeVisible.value = false;
  }
};

const updateFullState = (state: FullStatePayload) => {
  log(`接收到完整状态更新`);
  isPlaying.value = state.isPlaying;
  isTransitioning.value = state.isTransitioning;
  currentItem.value = state.currentItem;
  playlist.value = state.playlist;
  masterVolume.value = state.masterVolume;
  playbackMode.value = state.playbackMode;

  if (state.currentItem) {
    activeIndex.value =
      state.playlist.length > 0
        ? state.playlist.findIndex(
            track =>
              track.title === state.currentItem!.title &&
              track.artist === state.currentItem!.artist &&
              track.cover === state.currentItem!.cover,
          )
        : -1;
  } else {
    activeIndex.value = -1;
  }
};

const togglePlayPause = () => musicPlayerAPI.value?.togglePlayPause();
const playNext = () => musicPlayerAPI.value?.playNext();
const playPrev = () => musicPlayerAPI.value?.playPrev();
const playIndex = (index: number) => musicPlayerAPI.value?.playIndex(index);

const updateVolumeFromEvent = (event: MouseEvent) => {
  if (!volumeTrackRef.value) return;
  const rect = volumeTrackRef.value.getBoundingClientRect();
  const relativeY = rect.bottom - event.clientY;
  const newVolume = Math.max(0, Math.min(1, relativeY / rect.height));
  masterVolume.value = newVolume;
  musicPlayerAPI.value?.setLiveVolume(newVolume);
};

const handleVolumeDrag = (event: MouseEvent) => {
  updateVolumeFromEvent(event);
};

const endVolumeDrag = () => {
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);
  musicPlayerAPI.value?.persistVolumeAndBroadcast(masterVolume.value);
};

const startVolumeDrag = (event: MouseEvent) => {
  updateVolumeFromEvent(event);
  document.addEventListener('mousemove', handleVolumeDrag);
  document.addEventListener('mouseup', endVolumeDrag, { once: true });
};

onUnmounted(() => {
  if (unregisterStateListener) {
    unregisterStateListener();
    console.log('[播放器前端] 已注销状态监听器，防止内存泄漏。');
  }
});

function waitForGlobalObject(objectName: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      // @ts-expect-error top 是一个全局浏览器对象
      if (typeof top[objectName] === 'object' && top[objectName] !== null) {
        clearInterval(interval);
        // @ts-expect-error top 是一个全局浏览器对象
        resolve(top[objectName]);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`连接后台脚本失败。请确认角色卡的脚本开关已打开。若已打开请刷新页面重试。`));
      }
    }, 100);
  });
}

onMounted(() => {
  console.log('播放器前端已挂载。检查 onLongPress:', onLongPress);
  (async () => {
    try {
      log('开始初始化流程... 界面当前为透明状态。');
      const api: MusicPlayerAPI = await waitForGlobalObject('musicPlayerAPI', 10000);
      log('后台脚本API "musicPlayerAPI" 已就绪。');
      await Promise.race([
        api.requestInitialization(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('后台脚本初始化超时。如果这是您第一次加载角色卡，请尝试刷新页面。')),
            10000,
          ),
        ),
      ]);
      log('后台初始化请求已成功完成。');
      musicPlayerAPI.value = api;
      const initialState = api.getCurrentState();
      updateFullState(initialState);
      unregisterStateListener = api.onFullStateUpdate(updateFullState);
      log('初始化成功！界面已与后台同步。');
      log('[幕启] 后台状态已同步，即将显示界面。');
      isReadyToShow.value = true;
    } catch (error) {
      const errorMsg = `初始化流程失败: ${error}`;
      log(errorMsg);
      initializationError.value = error instanceof Error ? error.message : String(error);
      isReadyToShow.value = true;
    }
  })();
});
</script>

<style scoped>
.player-root {
  position: relative;
  width: 100%;
  max-width: 300px;
  margin-left: auto;
  margin-right: auto;
}

/* 1. 根容器与核心布局 */
.aria-pod-container {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #f2f2f7;
  width: 100%; /* 继承自 player-root 的宽度 */
  /* [修改点] V9.1 - 优化了动画曲线，使其感觉更平滑 */
  transition:
    height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.25s ease-in-out;
  height: 120px;
  box-sizing: border-box;
  opacity: 0;
  pointer-events: none;
  position: relative;
  will-change: height; /* 提示浏览器此属性将要动画，可能有助于性能 */
}
.aria-pod-container.is-ready {
  opacity: 1;
  pointer-events: auto;
}
.aria-pod-container.is-playlist-open {
  height: 240px;
}
.aria-pod-container.is-transitioning {
  opacity: 0.7;
  pointer-events: none;
}
.player-content-wrapper {
  background-color: #1c1c1e;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  padding: 12px;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  z-index: 1;
}
.player-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

/* 2. 曲目信息区 (无变化) */
.track-info {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
}
.cover-art {
  width: 52px;
  height: 52px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}
.cover-art-placeholder {
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #161618;
  font-size: 22px;
  color: #8e8e93;
}
.details {
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.details p {
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  font-weight: 600;
  font-size: 16px;
  color: #ffffff;
}
.artist {
  font-size: 13px;
  color: #8e8e93;
}

/* 3. 控制区 (无变化) */
.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.main-controls {
  display: flex;
  align-items: center;
  gap: 16px;
}
.control-btn {
  background: none;
  border: none;
  color: #f2f2f7;
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  justify-content: center;
  align-items: center;
  transition:
    background-color 0.2s ease,
    transform 0.1s ease;
  font-size: 15px;
  width: 30px;
  height: 30px;
}
.control-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
}
.control-btn:active {
  transform: scale(0.92);
  background-color: rgba(255, 255, 255, 0.15);
}
.play-pause-btn {
  font-size: 16px;
  width: 36px;
  height: 36px;
}
.volume-control-wrapper,
.controls > .control-btn:first-child {
  width: 30px;
}

/* 4. 自定义音量滑块样式 (有修改) */
.volume-slider-container {
  position: absolute;
  /* [修改点] V9.1 - 重新计算了 bottom 和 right，使其精确定位 */
  bottom: 40px; /* 向上偏移，使其出现在按钮上方 */
  right: 27px; /* 移动到与音量按钮中心对齐的位置 */
  transform: translateX(50%); /* 将容器自身的中心对齐到 right 指定的点 */
  animation: grow-up 0.2s cubic-bezier(0.25, 1, 0.5, 1);
  z-index: 10;
  padding: 10px 0;
  display: flex;
  justify-content: center;
}
.custom-volume-slider {
  position: relative;
  width: 24px;
  /* [修改点] V9.1 - 缩短了音量条高度，防止超出容器 */
  height: 65px;
  cursor: pointer;
}
.custom-volume-slider .track {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 6px;
  height: 100%;
  background-color: #3a3a3c;
  border-radius: 3px;
  overflow: hidden;
}
.custom-volume-slider .progress {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  background-color: #0a84ff;
  border-radius: 3px;
}
.custom-volume-slider .thumb {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  /* [修改点] V9.1 - 缩小了滑块尺寸 */
  width: 8px;
  height: 8px;
  background-color: #ffffff;
  border-radius: 50%;
  pointer-events: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
@keyframes grow-up {
  from {
    opacity: 0;
    transform: translateX(50%) scaleY(0.5);
    transform-origin: bottom;
  }
  to {
    opacity: 1;
    transform: translateX(50%) scaleY(1);
    transform-origin: bottom;
  }
}

/* 5. 播放列表抽屉 (有修改) */
.playlist-drawer {
  flex-grow: 1;
  overflow-y: auto;
  margin: 4px -12px -12px;
  padding: 4px 8px 12px 8px;
  scrollbar-width: thin;
  scrollbar-color: #8e8e93 #3a3a3c;
  /* [修改点] V9.1 - 采用 max-height 来实现动画，解决性能问题 */
  transition:
    max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.2s ease;
  max-height: 0;
  opacity: 0;
  visibility: hidden;
}
.aria-pod-container.is-playlist-open .playlist-drawer {
  max-height: 120px;
  opacity: 1;
  visibility: visible;
}
.playlist {
  list-style: none;
  padding: 0;
  margin: 0;
}
.playlist li {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.2s;
  animation: fade-in-up 0.3s ease-out both;
}
.playlist li:nth-child(1) {
  animation-delay: 0.05s;
}
.playlist li:nth-child(2) {
  animation-delay: 0.1s;
}
.playlist li:nth-child(3) {
  animation-delay: 0.15s;
}
.playlist li:nth-child(4) {
  animation-delay: 0.2s;
}
.playlist li:nth-child(5) {
  animation-delay: 0.25s;
}
@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.playlist li:hover {
  background-color: rgba(255, 255, 255, 0.1);
}
.playlist li.active {
  background-color: #0a84ff;
  color: white;
}
.playlist li.active .artist,
.playlist li.active .index {
  color: rgba(255, 255, 255, 0.8);
}
.playlist li .index {
  color: #8e8e93;
  text-align: right;
  font-size: 12px;
}
.playlist li .artist {
  color: #8e8e93;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 6. 错误状态 (无变化) */
.error-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 20px;
  background-color: rgba(255, 59, 48, 0.2);
  border: 1px solid rgba(255, 59, 48, 0.5);
  border-radius: 12px;
  z-index: 20;
}
.error-overlay p {
  margin: 0 0 5px 0;
}
.error-overlay small {
  margin: 0;
}
</style>
