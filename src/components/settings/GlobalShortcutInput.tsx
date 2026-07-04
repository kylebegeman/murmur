import React, { useCallback, useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  getKeyName,
  formatKeyCombination,
  normalizeKey,
} from "../../lib/utils/keyboard";
import { ResetButton } from "../ui/ResetButton";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { useOsType } from "../../hooks/useOsType";
import { commands } from "@/bindings";
import { toast } from "sonner";

interface GlobalShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
}

const MODIFIER_KEYS = [
  "ctrl",
  "control",
  "shift",
  "alt",
  "option",
  "meta",
  "command",
  "cmd",
  "super",
  "win",
  "windows",
  "fn",
];

const sortShortcutKeys = (keys: string[]): string[] =>
  [...keys].sort((a, b) => {
    const aIsModifier = MODIFIER_KEYS.includes(a.toLowerCase());
    const bIsModifier = MODIFIER_KEYS.includes(b.toLowerCase());
    if (aIsModifier && !bIsModifier) return -1;
    if (!aIsModifier && bIsModifier) return 1;
    return 0;
  });

export const GlobalShortcutInput: React.FC<GlobalShortcutInputProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
  shortcutId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateBinding, resetBinding, isUpdating, isLoading } =
    useSettings();
  const [keyPressed, setKeyPressed] = useState<string[]>([]);
  const [recordedKeys, setRecordedKeys] = useState<string[]>([]);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(
    null,
  );
  const [originalBinding, setOriginalBinding] = useState<string>("");
  const shortcutRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const recordedKeysRef = useRef<string[]>([]);
  const isCommittingRef = useRef(false);
  const osType = useOsType();

  const bindings = getSetting("bindings") || {};
  const bindingUpdateKey = `binding_${shortcutId}`;

  const resetCaptureState = useCallback(() => {
    pressedKeysRef.current.clear();
    recordedKeysRef.current = [];
    isCommittingRef.current = false;
    setKeyPressed([]);
    setRecordedKeys([]);
  }, []);

  useEffect(() => {
    // Only add event listeners when we're in editing mode
    if (editingShortcutId === null) return;

    let cleanup = false;

    // Keyboard event listeners
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (cleanup || isCommittingRef.current) return;
      if (e.repeat) return; // ignore auto-repeat
      e.preventDefault();

      // Get the key with OS-specific naming and normalize it
      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);

      if (!pressedKeysRef.current.has(key)) {
        pressedKeysRef.current.add(key);
        setKeyPressed([...pressedKeysRef.current]);
      }

      if (!recordedKeysRef.current.includes(key)) {
        recordedKeysRef.current = [...recordedKeysRef.current, key];
        setRecordedKeys(recordedKeysRef.current);
      }
    };

    const handleKeyUp = async (e: KeyboardEvent) => {
      if (cleanup || isCommittingRef.current) return;
      e.preventDefault();

      // Get the key with OS-specific naming and normalize it
      const rawKey = getKeyName(e, osType);
      const key = normalizeKey(rawKey);

      // Remove from currently pressed keys
      pressedKeysRef.current.delete(key);
      setKeyPressed([...pressedKeysRef.current]);

      // If no keys are pressed anymore, commit the shortcut
      if (
        pressedKeysRef.current.size === 0 &&
        recordedKeysRef.current.length > 0
      ) {
        isCommittingRef.current = true;
        // Create the shortcut string from all recorded keys
        // Sort keys so modifiers come first, then the main key
        const sortedKeys = sortShortcutKeys(recordedKeysRef.current);
        const newShortcut = sortedKeys.join("+");

        if (editingShortcutId && bindings[editingShortcutId]) {
          try {
            await updateBinding(editingShortcutId, newShortcut);
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
                await updateBinding(editingShortcutId, originalBinding);
              } catch (resetError) {
                console.error("Failed to reset binding:", resetError);
                toast.error(t("settings.general.shortcut.errors.reset"));
              }
            }
          }

          // Exit editing mode and reset states
          setEditingShortcutId(null);
          resetCaptureState();
          setOriginalBinding("");
        }
      }
    };

    // Add click outside handler
    const handleClickOutside = async (e: MouseEvent) => {
      if (cleanup) return;
      const activeElement = shortcutRefs.current.get(editingShortcutId);
      if (activeElement && !activeElement.contains(e.target as Node)) {
        // Cancel shortcut recording and restore original binding
        if (editingShortcutId && originalBinding) {
          try {
            await updateBinding(editingShortcutId, originalBinding);
          } catch (error) {
            console.error("Failed to restore original binding:", error);
            toast.error(t("settings.general.shortcut.errors.restore"));
          }
        } else if (editingShortcutId) {
          commands.resumeBinding(editingShortcutId).catch(console.error);
        }
        setEditingShortcutId(null);
        resetCaptureState();
        setOriginalBinding("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("click", handleClickOutside);

    return () => {
      cleanup = true;
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("click", handleClickOutside);
    };
  }, [
    editingShortcutId,
    bindings,
    originalBinding,
    updateBinding,
    resetCaptureState,
    osType,
    t,
  ]);

  // Start recording a new shortcut
  const startRecording = async (id: string) => {
    if (editingShortcutId === id || disabled) return; // Already editing this shortcut

    // Suspend current binding to avoid firing while recording
    await commands.suspendBinding(id).catch(console.error);

    // Store the original binding to restore if canceled
    setOriginalBinding(bindings[id]?.current_binding || "");
    setEditingShortcutId(id);
    resetCaptureState();
  };

  // Format the current shortcut keys being recorded
  const formatCurrentKeys = (): string => {
    if (recordedKeys.length === 0)
      return t("settings.general.shortcut.pressKeys");

    // Use the same formatting as the display to ensure consistency
    return formatKeyCombination(recordedKeys.join("+"), osType);
  };

  // Store references to shortcut elements
  const setShortcutRef = (id: string, ref: HTMLDivElement | null) => {
    shortcutRefs.current.set(id, ref);
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
        {editingShortcutId === shortcutId ? (
          <div
            ref={(ref) => setShortcutRef(shortcutId, ref)}
            className="px-2 py-1 text-sm font-semibold border border-logo-primary bg-logo-primary/30 rounded-md"
          >
            {formatCurrentKeys()}
          </div>
        ) : (
          <div
            className="px-2 py-1 text-sm font-semibold bg-mid-gray/10 border border-mid-gray/80 hover:bg-logo-primary/10 rounded-md cursor-pointer hover:border-logo-primary"
            onClick={() => startRecording(shortcutId)}
          >
            {formatKeyCombination(binding.current_binding, osType)}
          </div>
        )}
        <ResetButton
          onClick={() => resetBinding(shortcutId)}
          disabled={isUpdating(bindingUpdateKey)}
        />
      </div>
    </SettingContainer>
  );
};
