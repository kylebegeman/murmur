import React, { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { formatKeyCombination } from "../../lib/utils/keyboard";
import { ResetButton } from "../ui/ResetButton";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";

interface HandyKeysShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
}

interface HandyKeysEvent {
  modifiers: string[];
  key: string | null;
  is_key_down: boolean;
  hotkey_string: string;
}

const buildShortcutString = (
  modifiers: string[],
  activeKeys: Set<string>,
  key: string | null,
): string => {
  const parts = [...modifiers];
  const keys = [...activeKeys];
  const mainKey = key ?? keys[keys.length - 1];
  if (mainKey) {
    parts.push(mainKey);
  }
  return parts.join("+");
};

const shortcutWeight = (shortcut: string): number =>
  shortcut ? shortcut.split("+").filter(Boolean).length : 0;

export const HandyKeysShortcutInput: React.FC<HandyKeysShortcutInputProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
  shortcutId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateBinding, resetBinding, isUpdating, isLoading } =
    useSettings();
  const [isRecording, setIsRecording] = useState(false);
  const [currentKeys, setCurrentKeys] = useState<string>("");
  const [originalBinding, setOriginalBinding] = useState<string>("");
  const shortcutRef = useRef<HTMLDivElement | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const activeModifiersRef = useRef<Set<string>>(new Set());
  const activeKeysRef = useRef<Set<string>>(new Set());
  const recordedShortcutRef = useRef<string>("");
  const isCommittingRef = useRef(false);
  const osType = useOsType();

  const bindings = getSetting("bindings") || {};
  const bindingUpdateKey = `binding_${shortcutId}`;

  const resetCaptureState = useCallback(() => {
    activeModifiersRef.current.clear();
    activeKeysRef.current.clear();
    recordedShortcutRef.current = "";
    isCommittingRef.current = false;
    setCurrentKeys("");
  }, []);

  // Handle cancellation
  const cancelRecording = useCallback(async () => {
    if (!isRecording) return;

    // Stop listening for backend events
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }

    // Stop backend recording
    await commands.stopHandyKeysRecording().catch(console.error);

    // Restore original binding
    if (originalBinding) {
      try {
        await updateBinding(shortcutId, originalBinding);
      } catch (error) {
        console.error("Failed to restore original binding:", error);
        toast.error(t("settings.general.shortcut.errors.restore"));
      }
    } else {
      commands.resumeBinding(shortcutId).catch(console.error);
    }

    setIsRecording(false);
    resetCaptureState();
    setOriginalBinding("");
  }, [
    isRecording,
    originalBinding,
    shortcutId,
    updateBinding,
    resetCaptureState,
    t,
  ]);

  // Set up event listener for handy-keys events
  useEffect(() => {
    if (!isRecording) return;

    let cleanup = false;

    const setupListener = async () => {
      // Listen for key events from backend
      const unlisten = await listen<HandyKeysEvent>(
        "handy-keys-event",
        async (event) => {
          if (cleanup || isCommittingRef.current) return;

          const { hotkey_string, is_key_down, key, modifiers } = event.payload;

          activeModifiersRef.current = new Set(modifiers);

          if (is_key_down) {
            if (key) {
              activeKeysRef.current.add(key);
            }

            const shortcut =
              hotkey_string ||
              buildShortcutString(modifiers, activeKeysRef.current, key);
            if (
              shortcut &&
              shortcutWeight(shortcut) >=
                shortcutWeight(recordedShortcutRef.current)
            ) {
              recordedShortcutRef.current = shortcut;
              setCurrentKeys(shortcut);
            }
            return;
          }

          if (key) {
            activeKeysRef.current.delete(key);
          }

          const allKeysReleased =
            activeModifiersRef.current.size === 0 &&
            activeKeysRef.current.size === 0;

          if (allKeysReleased && recordedShortcutRef.current) {
            isCommittingRef.current = true;
            const keysToCommit = recordedShortcutRef.current;
            try {
              await updateBinding(shortcutId, keysToCommit);
            } catch (error) {
              console.error("Failed to change binding:", error);
              toast.error(
                t("settings.general.shortcut.errors.set", {
                  error: String(error),
                }),
              );

              // Reset to original binding on error
              if (originalBinding) {
                try {
                  await updateBinding(shortcutId, originalBinding);
                } catch (resetError) {
                  console.error("Failed to reset binding:", resetError);
                  toast.error(t("settings.general.shortcut.errors.reset"));
                }
              }
            }

            // Stop recording
            if (unlistenRef.current) {
              unlistenRef.current();
              unlistenRef.current = null;
            }
            await commands.stopHandyKeysRecording().catch(console.error);
            setIsRecording(false);
            resetCaptureState();
            setOriginalBinding("");
          }
        },
      );

      unlistenRef.current = unlisten;
    };

    setupListener();

    return () => {
      cleanup = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      // Stop backend recording on unmount to prevent orphaned recording loops
      commands.stopHandyKeysRecording().catch(console.error);
    };
  }, [
    isRecording,
    shortcutId,
    originalBinding,
    updateBinding,
    resetCaptureState,
    cancelRecording,
    t,
  ]);

  // Handle click outside
  useEffect(() => {
    if (!isRecording) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        shortcutRef.current &&
        !shortcutRef.current.contains(e.target as Node)
      ) {
        cancelRecording();
      }
    };

    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [isRecording, cancelRecording]);

  // Start recording a new shortcut
  const startRecording = async () => {
    if (isRecording || disabled) return;

    const originalShortcut = bindings[shortcutId]?.current_binding || "";

    // Store the original binding to restore if canceled
    setOriginalBinding(originalShortcut);

    // Start backend recording
    try {
      await commands.suspendBinding(shortcutId);
      await commands.startHandyKeysRecording(shortcutId);
      setIsRecording(true);
      resetCaptureState();
    } catch (error) {
      await commands.resumeBinding(shortcutId).catch(console.error);
      console.error("Failed to start recording:", error);
      toast.error(
        t("settings.general.shortcut.errors.set", { error: String(error) }),
      );
    }
  };

  const setFnBinding = async () => {
    if (disabled || isUpdating(bindingUpdateKey)) return;

    try {
      await updateBinding(shortcutId, "fn");
    } catch (error) {
      console.error("Failed to set fn binding:", error);
      toast.error(
        t("settings.general.shortcut.errors.set", {
          error: String(error),
        }),
      );
    }
  };

  // Format the current shortcut keys being recorded
  const formatCurrentKeys = (): string => {
    if (!currentKeys) return t("settings.general.shortcut.pressKeys");
    return formatKeyCombination(currentKeys, osType);
  };

  // If still loading, show loading state
  if (isLoading) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.loading")}
        </div>
      </SettingContainer>
    );
  }

  // If no bindings are loaded, show empty state
  if (Object.keys(bindings).length === 0) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  const binding = bindings[shortcutId];
  if (!binding) {
    return (
      <SettingContainer
        title={t("settings.general.shortcut.title")}
        description={t("settings.general.shortcut.notFound")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <div className="text-sm text-mid-gray">
          {t("settings.general.shortcut.none")}
        </div>
      </SettingContainer>
    );
  }

  // Get translated name and description for the binding
  const translatedName = t(
    `settings.general.shortcut.bindings.${shortcutId}.name`,
    binding.name,
  );
  const translatedDescription = t(
    `settings.general.shortcut.bindings.${shortcutId}.description`,
    binding.description,
  );

  return (
    <SettingContainer
      title={translatedName}
      description={translatedDescription}
      descriptionMode={descriptionMode}
      grouped={grouped}
      disabled={disabled}
      layout="horizontal"
    >
      <div className="flex items-center space-x-1">
        {isRecording ? (
          <div
            ref={shortcutRef}
            className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md"
          >
            {formatCurrentKeys()}
          </div>
        ) : (
          <div
            className="px-2 py-1 text-sm font-semibold bg-mid-gray/10 border border-mid-gray/80 hover:bg-logo-primary/10 rounded-md cursor-pointer hover:border-logo-primary"
            onClick={startRecording}
          >
            {formatKeyCombination(binding.current_binding, osType)}
          </div>
        )}
        <ResetButton
          onClick={() => resetBinding(shortcutId)}
          disabled={isUpdating(bindingUpdateKey)}
        />
        {osType === "macos" && !isRecording ? (
          <button
            type="button"
            className="px-2 py-1 text-sm font-semibold bg-mid-gray/10 border border-mid-gray/80 hover:bg-logo-primary/10 rounded-md cursor-pointer hover:border-logo-primary disabled:cursor-not-allowed disabled:opacity-50"
            onClick={setFnBinding}
            disabled={disabled || isUpdating(bindingUpdateKey)}
            title={t("settings.general.shortcut.setFn")}
            aria-label={t("settings.general.shortcut.setFn")}
          >
            {formatKeyCombination("fn", osType)}
          </button>
        ) : null}
      </div>
    </SettingContainer>
  );
};
