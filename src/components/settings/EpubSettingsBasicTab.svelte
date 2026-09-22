<script lang="ts">
  import type { TextComponent } from "obsidian";
  import { onMount, untrack } from "svelte";
  import {
    normalizeContinuousReadingPositionAutoSaveEnabled,
    normalizeContinuousReadingPositionAutoSavePages,
  } from "../../config/reading-position-auto-save";
  import { EPUB_RUNTIME } from "../../services/epub";
  import { normalizeDataPath } from "../../config/paths";
  import type StandaloneEpubPlugin from "../../main";
  import { createEpubBasicSettingsActions } from "./epub-basic-settings-actions";
  import { mountEpubBasicSettings } from "./mount-epub-basic-settings";

  interface Props {
    plugin: StandaloneEpubPlugin;
  }

  let { plugin }: Props = $props();
  let stateVersion = $state(0);
  let excerptSettingsVersion = $state(0);
  let interfaceSettingsHost = $state<HTMLDivElement | null>(null);
  let readingSettingsHost = $state<HTMLDivElement | null>(null);
  let diagnosticsSettingsHost = $state<HTMLDivElement | null>(null);

  let dataPathInput = $state("");
  let continuousReadingPositionAutoSavePagesInput = $state("");
  let autoSavePagesTextControl = $state<TextComponent | null>(null);

  async function save(): Promise<void> {
    await plugin.saveSettings();
    stateVersion += 1;
  }

  let dataPathValue = $derived.by(() => {
    stateVersion;
    return normalizeDataPath(plugin.settings?.dataPath);
  });

  let debugModeEnabled = $derived.by(() => {
    stateVersion;
    return plugin.settings?.enableDebugMode === true;
  });

  let sourceNavigationOpenInNewTab = $derived.by(() => {
    stateVersion;
    return plugin.settings?.sourceNavigationOpenInNewTab !== false;
  });

  let excerptParagraphHoverPreviewEnabled = $derived.by(() => {
    stateVersion;
    return plugin.settings?.excerptParagraphHoverPreviewEnabled !== false;
  });

  let showAutoInsertButtonOnReader = $derived.by(() => {
    stateVersion;
    return plugin.settings?.showAutoInsertButtonOnReader === true;
  });

  let largeNavButtonsEnabled = $derived.by(() => {
    stateVersion;
    return plugin.settings?.enableLargeNavButtons === true;
  });

  let continuousReadingPositionAutoSaveEnabled = $derived.by(() => {
    stateVersion;
    return normalizeContinuousReadingPositionAutoSaveEnabled(
      plugin.settings?.continuousReadingPositionAutoSaveEnabled
    );
  });

  let continuousReadingPositionAutoSavePages = $derived.by(() => {
    stateVersion;
    return normalizeContinuousReadingPositionAutoSavePages(
      plugin.settings?.continuousReadingPositionAutoSavePages
    );
  });

  const actions = createEpubBasicSettingsActions({
    plugin,
    getDataPathValue: () => dataPathValue,
    getContinuousReadingPositionAutoSaveEnabled: () => continuousReadingPositionAutoSaveEnabled,
    getContinuousReadingPositionAutoSavePages: () => continuousReadingPositionAutoSavePages,
    getSourceNavigationOpenInNewTab: () => sourceNavigationOpenInNewTab,
    getExcerptParagraphHoverPreviewEnabled: () => excerptParagraphHoverPreviewEnabled,
    getShowAutoInsertButtonOnReader: () => showAutoInsertButtonOnReader,
    getLargeNavButtonsEnabled: () => largeNavButtonsEnabled,
    getDebugModeEnabled: () => debugModeEnabled,
    getAutoSavePagesTextControl: () => autoSavePagesTextControl,
    setDataPathInput: (value) => {
      dataPathInput = value;
    },
    setContinuousReadingPositionAutoSavePagesInput: (value) => {
      continuousReadingPositionAutoSavePagesInput = value;
    },
    setExcerptSettingsVersion: (updater) => {
      excerptSettingsVersion = updater(excerptSettingsVersion);
    },
    save,
  });

  $effect(() => {
    dataPathValue;
    dataPathInput = dataPathValue;
  });

  $effect(() => {
    continuousReadingPositionAutoSavePages;
    continuousReadingPositionAutoSavePagesInput = String(continuousReadingPositionAutoSavePages);
  });

  onMount(() => {
    const handleExcerptSettingsChanged = () => {
      excerptSettingsVersion += 1;
    };
    if (typeof window !== "undefined") {
      window.addEventListener(
        EPUB_RUNTIME.events.excerptSettingsChanged,
        handleExcerptSettingsChanged
      );
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(
          EPUB_RUNTIME.events.excerptSettingsChanged,
          handleExcerptSettingsChanged
        );
      }
    };
  });

  $effect(() => {
    if (
      !interfaceSettingsHost
      || !readingSettingsHost
      || !diagnosticsSettingsHost
    ) {
      return;
    }

    excerptSettingsVersion;

    let dispose: (() => void) | undefined;

    untrack(() => {
      dispose = mountEpubBasicSettings({
        plugin,
        hosts: {
          interface: interfaceSettingsHost,
          reading: readingSettingsHost,
          diagnostics: diagnosticsSettingsHost,
        },
        snapshot: {
          dataPathValue,
          dataPathInput,
          continuousReadingPositionAutoSaveEnabled,
          continuousReadingPositionAutoSavePages,
          continuousReadingPositionAutoSavePagesInput,
          sourceNavigationOpenInNewTab,
          excerptParagraphHoverPreviewEnabled,
          showAutoInsertButtonOnReader,
          largeNavButtonsEnabled,
          debugModeEnabled,
        },
        callbacks: {
          save,
          setDataPathInput: (value) => {
            dataPathInput = value;
          },
          setContinuousReadingPositionAutoSavePagesInput: (value) => {
            continuousReadingPositionAutoSavePagesInput = value;
          },
          setAutoSavePagesTextControl: (control) => {
            autoSavePagesTextControl = control;
          },
          updateDataPath: actions.updateDataPath,
          updateContinuousReadingPositionAutoSaveEnabled:
            actions.updateContinuousReadingPositionAutoSaveEnabled,
          updateContinuousReadingPositionAutoSavePages:
            actions.updateContinuousReadingPositionAutoSavePages,
          updateSourceNavigationOpenInNewTab: actions.updateSourceNavigationOpenInNewTab,
          updateExcerptParagraphHoverPreview: actions.updateExcerptParagraphHoverPreview,
          updateShowAutoInsertButtonOnReader: actions.updateShowAutoInsertButtonOnReader,
          updateLargeNavButtons: actions.updateLargeNavButtons,
          updateDebugMode: actions.updateDebugMode,
        },
      });
    });

    return () => dispose?.();
  });
</script>

<section class="epub-settings-section epub-settings-section--compact">
  <div class="epub-settings-group epub-settings-group--panel epub-settings-group--preview-first">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-cyan">{'界面'}</h3>
    </div>
    <div bind:this={interfaceSettingsHost} class="epub-native-settings-host"></div>
  </div>

  <div class="epub-settings-group epub-settings-group--panel">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-purple">{'阅读位置与书签'}</h3>
    </div>
    <div bind:this={readingSettingsHost} class="epub-native-settings-host"></div>
  </div>

  <div class="epub-settings-group epub-settings-group--panel">
    <div class="epub-settings-group-header">
      <h3 class="epub-settings-group-title with-accent-bar accent-cyan">{'开发与诊断'}</h3>
    </div>
    <div bind:this={diagnosticsSettingsHost} class="epub-native-settings-host"></div>
  </div>
</section>
