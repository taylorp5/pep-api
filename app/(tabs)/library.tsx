import { useState, useCallback, useRef, useMemo } from 'react';
import {
  StyleSheet,
  View,
  TouchableOpacity,
  SectionList,
  Alert,
  Modal,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import { useFocusEffect } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { pepTheme } from '@/constants/pep-theme';
import { useUser } from '@/contexts/UserContext';
import { useAudioPlayback } from '@/contexts/AudioPlaybackContext';
import {
  loadSavedPeps,
  deletePep,
  updatePepTitle,
  audioFileExists,
  type PepItem,
} from '@/services/PepLibrary';

/** Local calendar date key (YYYY-MM-DD) for grouping */
function getDateKey(createdAt: number): string {
  const d = new Date(createdAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Section header label: Today, Yesterday, or "Feb 18, 2026" */
function formatSectionTitle(dateKey: string): string {
  const now = new Date();
  const todayKey = getDateKey(now.getTime());
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = getDateKey(yesterday.getTime());
  if (dateKey === todayKey) return 'Today';
  if (dateKey === yesterdayKey) return 'Yesterday';
  const [y, m, day] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, day);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function formatDate(createdAt: number): string {
  const date = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

export type LibrarySection = { title: string; dateKey: string; data: PepItem[] };

function buildSections(items: PepItem[]): LibrarySection[] {
  const byDate = new Map<string, PepItem[]>();
  for (const item of items) {
    const key = getDateKey(item.createdAt);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(item);
  }
  for (const arr of byDate.values()) {
    arr.sort((a, b) => b.createdAt - a.createdAt);
  }
  const keys = Array.from(byDate.keys()).sort().reverse();
  return keys.map((dateKey) => ({
    title: formatSectionTitle(dateKey),
    dateKey,
    data: byDate.get(dateKey)!,
  }));
}

/** Flow: order for playlist so session parts play sequentially (part 0, 1, 2…). */
function getPlaylistOrder(items: PepItem[]): PepItem[] {
  const bySession = new Map<string, PepItem[]>();
  for (const item of items) {
    const key = item.sessionId ?? `standalone-${item.id}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(item);
  }
  for (const arr of bySession.values()) {
    arr.sort((a, b) => (a.sessionPartIndex ?? 0) - (b.sessionPartIndex ?? 0));
  }
  const sessions = Array.from(bySession.entries());
  sessions.sort(([, a], [, b]) => {
    const maxA = Math.max(...a.map((i) => i.createdAt));
    const maxB = Math.max(...b.map((i) => i.createdAt));
    return maxB - maxA;
  });
  return sessions.flatMap(([, arr]) => arr);
}

export default function LibraryTabScreen() {
  const insets = useSafeAreaInsets();
  const { entitlement } = useUser();
  const canRead = entitlement === 'pro' || entitlement === 'flow';
  const isFlow = entitlement === 'flow';
  const { stopCurrent, setCurrentSound } = useAudioPlayback();

  const theme = pepTheme;

  const [items, setItems] = useState<PepItem[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pausedId, setPausedId] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewTextItem, setViewTextItem] = useState<PepItem | null>(null);
  const [editItem, setEditItem] = useState<PepItem | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState('');
  const soundRef = useRef<Audio.Sound | null>(null);

  // Flow-only queue/playlist state (most recent first)
  const [queue, setQueue] = useState<PepItem[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [queueSkippedMessage, setQueueSkippedMessage] = useState<string | null>(null);
  const queueIndexRef = useRef(0);
  const queueRef = useRef<PepItem[]>([]);
  const playQueueItemAtRef = useRef<(index: number) => Promise<void>>(async () => {});
  const isQueueActive = queue.length > 0;

  const load = useCallback(async () => {
    const list = await loadSavedPeps();
    setItems(list);
  }, []);

  const sections = useMemo(() => buildSections(items), [items]);

  const clearQueueState = useCallback(() => {
    setQueue([]);
    setQueueIndex(0);
    queueRef.current = [];
    queueIndexRef.current = 0;
    setQueueSkippedMessage(null);
  }, []);

  const handleStop = useCallback(async () => {
    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch (e) {}
      setCurrentSound(null);
      soundRef.current = null;
      setSound(null);
      setPlayingId(null);
      setPausedId(null);
    }
    if (queueRef.current.length > 0) {
      clearQueueState();
    }
  }, [clearQueueState]);

  const advanceToNext = useCallback(() => {
    setPlayingId(null);
    setPausedId(null);
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    if (idx + 1 < q.length) {
      queueIndexRef.current = idx + 1;
      setQueueIndex(idx + 1);
      playQueueItemAtRef.current(idx + 1);
    } else {
      handleStop();
      clearQueueState();
    }
  }, [handleStop, clearQueueState]);

  const playQueueItemAt = useCallback(
    async (index: number) => {
      const q = queueRef.current;
      if (index < 0 || index >= q.length) return;
      const item = q[index];
      await stopCurrent();
      if (soundRef.current) {
        try {
          await soundRef.current.unloadAsync();
        } catch (_) {}
        soundRef.current = null;
        setSound(null);
      }
      setPlayingId(null);
      setPausedId(null);

      const exists = await audioFileExists(item.audioUriLocal);
      if (!exists) {
        console.warn('[Library] Play All: skipping missing file', item.id, item.title, item.audioUriLocal);
        setQueueSkippedMessage(`Skipped "${item.title}" (file missing)`);
        setTimeout(() => setQueueSkippedMessage(null), 3000);
        if (index + 1 < q.length) {
          queueIndexRef.current = index + 1;
          setQueueIndex(index + 1);
          playQueueItemAtRef.current(index + 1);
        } else {
          handleStop();
          clearQueueState();
        }
        return;
      }

      try {
        const { sound: newSound } = await Audio.Sound.createAsync(
          { uri: item.audioUriLocal },
          { shouldPlay: true }
        );
        soundRef.current = newSound;
        setSound(newSound);
        setCurrentSound(newSound);
        setPlayingId(item.id);
        newSound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            advanceToNext();
          }
        });
      } catch (err) {
        console.error('[Library] Play All: failed to load', item.id, err);
        setQueueSkippedMessage(`Skipped "${item.title}" (playback error)`);
        setTimeout(() => setQueueSkippedMessage(null), 3000);
        if (index + 1 < q.length) {
          queueIndexRef.current = index + 1;
          setQueueIndex(index + 1);
          playQueueItemAtRef.current(index + 1);
        } else {
          handleStop();
          clearQueueState();
        }
      }
    },
    [stopCurrent, setCurrentSound, advanceToNext, handleStop, clearQueueState]
  );
  playQueueItemAtRef.current = playQueueItemAt;

  const handlePlayAll = useCallback(async () => {
    if (!isFlow || items.length === 0) return;
    const ordered = getPlaylistOrder(items);
    const valid: PepItem[] = [];
    for (const item of ordered) {
      const exists = await audioFileExists(item.audioUriLocal);
      if (!exists) {
        console.warn('[Library] Play All: excluding missing file', item.id, item.title, item.audioUriLocal);
      } else {
        valid.push(item);
      }
    }
    const skippedCount = ordered.length - valid.length;
    if (skippedCount > 0) {
      setQueueSkippedMessage(
        skippedCount === 1
          ? '1 item skipped (file missing)'
          : `${skippedCount} items skipped (file missing)`
      );
      setTimeout(() => setQueueSkippedMessage(null), 4000);
    }
    if (valid.length === 0) {
      Alert.alert(
        'Nothing to play',
        'No audio files were found. They may have been removed. Try removing items from your library and saving again from Home.'
      );
      return;
    }
    queueRef.current = valid;
    queueIndexRef.current = 0;
    setQueue(valid);
    setQueueIndex(0);
    playQueueItemAt(0);
  }, [isFlow, items, playQueueItemAt]);

  const handleQueueStop = useCallback(() => {
    handleStop();
  }, [handleStop]);

  const handleSkipNext = useCallback(() => {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    if (idx + 1 < q.length) {
      queueIndexRef.current = idx + 1;
      setQueueIndex(idx + 1);
      playQueueItemAtRef.current(idx + 1);
    } else {
      handleStop();
      clearQueueState();
    }
  }, [handleStop, clearQueueState]);

  const handleSkipPrevious = useCallback(() => {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    if (idx <= 0) {
      if (soundRef.current) {
        soundRef.current.setPositionAsync(0).catch(() => {});
        soundRef.current.playAsync().catch(() => {});
      }
      return;
    }
    queueIndexRef.current = idx - 1;
    setQueueIndex(idx - 1);
    playQueueItemAtRef.current(idx - 1);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        const s = soundRef.current;
        if (s) {
          s.stopAsync().catch(() => {});
          s.unloadAsync().catch(() => {});
          setCurrentSound(null);
          soundRef.current = null;
          setSound(null);
          setPlayingId(null);
          setPausedId(null);
        }
        clearQueueState();
      };
    }, [load, setCurrentSound, clearQueueState])
  );

  const handlePlay = useCallback(async (item: PepItem) => {
    try {
      if (pausedId === item.id && soundRef.current) {
        await soundRef.current.playAsync();
        setPausedId(null);
        setPlayingId(item.id);
        return;
      }
      if (playingId === item.id) return;

      const exists = await audioFileExists(item.audioUriLocal);
      if (!exists) {
        console.warn('[Library] Cannot play: audio file missing', item.id, item.audioUriLocal);
        Alert.alert(
          'Audio not found',
          'This pep\'s audio file is missing. It may have been removed. Try removing it from your library and saving again from Home.'
        );
        return;
      }

      if (queueRef.current.length > 0) {
        clearQueueState();
      }
      await stopCurrent();
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
        setSound(null);
        setPlayingId(null);
        setPausedId(null);
      }
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: item.audioUriLocal },
        { shouldPlay: true }
      );
      soundRef.current = newSound;
      setSound(newSound);
      setCurrentSound(newSound);
      setPlayingId(item.id);
      setPausedId(null);
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingId(null);
          setPausedId(null);
        }
      });
    } catch (err) {
      console.error('[Library] Play error:', err);
      Alert.alert('Error', 'Could not play audio.');
    }
  }, [pausedId, playingId, stopCurrent, clearQueueState]);

  const handlePause = async (item: PepItem) => {
    if (soundRef.current && playingId === item.id) {
      try {
        await soundRef.current.pauseAsync();
        setPlayingId(null);
        setPausedId(item.id);
      } catch (e) {
        console.warn('Library pause error:', e);
      }
    }
  };

  const handleResume = async (item: PepItem) => {
    if (soundRef.current && pausedId === item.id) {
      try {
        await soundRef.current.playAsync();
        setPausedId(null);
        setPlayingId(item.id);
      } catch (e) {
        console.warn('Library resume error:', e);
      }
    }
  };

  const handleDelete = (item: PepItem) => {
    Alert.alert(
      'Remove from Library',
      `Remove "${item.title}" from your library?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            if (playingId === item.id || pausedId === item.id) await handleStop();
            await deletePep(item.id);
            await load();
            if (expandedId === item.id) setExpandedId(null);
          },
        },
      ]
    );
  };

  const openViewText = (item: PepItem) => {
    if (!canRead || !item.text) return;
    setViewTextItem(item);
  };

  const openEditTitle = (item: PepItem) => {
    if (item.kind !== 'custom') return;
    setEditItem(item);
    setEditTitleDraft(item.title);
  };

  const saveEditTitle = async () => {
    if (!editItem || !editTitleDraft.trim()) {
      setEditItem(null);
      return;
    }
    const newTitle = editTitleDraft.trim();
    try {
      await updatePepTitle(editItem.id, newTitle);
      await load();
      if (viewTextItem?.id === editItem.id) {
        setViewTextItem((prev) => (prev ? { ...prev, title: newTitle } : null));
      }
    } catch (e) {
      console.warn('Update title error:', e);
      Alert.alert('Error', 'Could not update title.');
    }
    setEditItem(null);
  };

  const renderItem = ({ item }: { item: PepItem }) => {
    const isExpanded = expandedId === item.id;
    const isPlaying = playingId === item.id;
    const isPaused = pausedId === item.id;

    return (
      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleRow}>
            <TouchableOpacity
              activeOpacity={0.8}
              style={styles.cardTitleTouch}
              onPress={() => setExpandedId(isExpanded ? null : item.id)}>
              <ThemedText style={[styles.cardTitle, { color: theme.text }]} numberOfLines={1}>
                {item.title}
              </ThemedText>
            </TouchableOpacity>
            {item.kind === 'custom' && (
              <TouchableOpacity
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                onPress={() => openEditTitle(item)}
                style={styles.editIconBtn}>
                <ThemedText style={[styles.editIcon, { color: theme.mutedText }]}>✏️</ThemedText>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.cardDateRow}>
            <ThemedText style={[styles.cardDate, { color: theme.mutedText }]}>
              {formatDate(item.createdAt)}
            </ThemedText>
            <View style={[styles.tag, { backgroundColor: theme.accentWarmMuted }]}>
              <ThemedText style={[styles.tagText, { color: theme.mutedText }]}>
                {item.kind === 'daily' ? 'Daily' : 'Saved'}
              </ThemedText>
            </View>
          </View>
        </View>

        {isExpanded && (
          <View style={styles.actions}>
            {isPlaying ? (
              <>
                <TouchableOpacity
                  style={[styles.btn, styles.playBtn, { backgroundColor: theme.accentWarm }]}
                  onPress={() => handlePause(item)}>
                  <ThemedText style={[styles.btnText, { color: theme.background }]}>⏸ Pause</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.stopBtn, { borderColor: theme.border }]}
                  onPress={handleStop}>
                  <ThemedText style={[styles.btnText, { color: theme.text }]}>⏹ Stop</ThemedText>
                </TouchableOpacity>
              </>
            ) : isPaused ? (
              <>
                <TouchableOpacity
                  style={[styles.btn, styles.playBtn, { backgroundColor: theme.accentWarm }]}
                  onPress={() => handleResume(item)}>
                  <ThemedText style={[styles.btnText, { color: theme.background }]}>▶ Resume</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btn, styles.stopBtn, { borderColor: theme.border }]}
                  onPress={handleStop}>
                  <ThemedText style={[styles.btnText, { color: theme.text }]}>⏹ Stop</ThemedText>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={[styles.btn, styles.playBtn, { backgroundColor: theme.accentWarm }]}
                onPress={() => handlePlay(item)}>
                <ThemedText style={[styles.btnText, { color: theme.background }]}>▶ Play</ThemedText>
              </TouchableOpacity>
            )}
            {canRead && item.text && (
              <TouchableOpacity
                style={[styles.btn, styles.secondaryBtn, { borderColor: theme.border }]}
                onPress={() => openViewText(item)}>
                <ThemedText style={[styles.btnText, { color: theme.text }]}>📖 View text</ThemedText>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.btn, styles.deleteBtn, { backgroundColor: theme.error }]}
              onPress={() => handleDelete(item)}>
              <ThemedText style={[styles.btnText, { color: theme.text }]}>🗑 Delete</ThemedText>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <ThemedView style={[styles.inner, { backgroundColor: 'transparent' }]}>
        {/* Background gradient (match Home) */}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.backgroundTop }]} />
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: theme.background }]} />
        <View style={[styles.header, { borderBottomColor: theme.border, paddingTop: insets.top + 6 }]}>
          <ThemedText style={[styles.title, { color: theme.text }]}>Library</ThemedText>
          <ThemedText style={[styles.subtitle, { color: theme.mutedText }]}>
            Saved peps · {items.length} item{items.length !== 1 ? 's' : ''}
          </ThemedText>
        </View>

        {queueSkippedMessage && (
          <View style={[styles.skippedBanner, { backgroundColor: theme.surfaceSoft, borderColor: theme.border }]}>
            <ThemedText style={[styles.skippedText, { color: theme.mutedText }]}>{queueSkippedMessage}</ThemedText>
          </View>
        )}

        {items.length === 0 ? (
          <View style={styles.empty}>
            <ThemedText style={[styles.emptyTitle, { color: theme.text }]}>
              No saved peps yet
            </ThemedText>
            <ThemedText style={[styles.emptySub, { color: theme.mutedText }]}>
              Save peps from Home (Pro / Flow) to replay them here.
            </ThemedText>
          </View>
        ) : (
          <>
            {isFlow && (
              <View style={[styles.playAllRow, { borderBottomColor: theme.border }]}>
                <TouchableOpacity
                  activeOpacity={0.8}
                  style={[styles.playAllButton, { backgroundColor: theme.accentWarm }]}
                  onPress={handlePlayAll}>
                  <ThemedText style={[styles.playAllButtonText, { color: theme.background }]}>▶ Play All</ThemedText>
                </TouchableOpacity>
              </View>
            )}

            {isQueueActive && queue.length > 0 && queueIndex < queue.length && (
              <View style={[styles.queueBar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <ThemedText style={[styles.queueBarTitle, { color: theme.mutedText }]}>Now playing</ThemedText>
                <ThemedText style={[styles.queueBarTrack, { color: theme.text }]} numberOfLines={1}>
                  {queue[queueIndex]?.title ?? '—'}
                </ThemedText>
                <ThemedText style={[styles.queueBarPosition, { color: theme.mutedText }]}>
                  {queueIndex + 1} of {queue.length}
                </ThemedText>
                <View style={styles.queueControls}>
                  <TouchableOpacity
                    style={[styles.queueControlBtn, { borderColor: theme.border }]}
                    onPress={handleSkipPrevious}>
                    <ThemedText style={[styles.queueControlText, { color: theme.text }]}>⏮ Prev</ThemedText>
                  </TouchableOpacity>
                  {playingId ? (
                    <TouchableOpacity
                      style={[styles.queueControlBtn, { backgroundColor: theme.accentWarm }]}
                      onPress={() => queue[queueIndex] && handlePause(queue[queueIndex])}>
                      <ThemedText style={[styles.queueControlText, { color: theme.background }]}>⏸ Pause</ThemedText>
                    </TouchableOpacity>
                  ) : pausedId ? (
                    <TouchableOpacity
                      style={[styles.queueControlBtn, { backgroundColor: theme.accentWarm }]}
                      onPress={() => queue[queueIndex] && handleResume(queue[queueIndex])}>
                      <ThemedText style={[styles.queueControlText, { color: theme.background }]}>▶ Resume</ThemedText>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={[styles.queueControlBtn, { borderColor: theme.border }]}
                    onPress={handleStop}>
                    <ThemedText style={[styles.queueControlText, { color: theme.text }]}>⏹ Stop</ThemedText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.queueControlBtn, { borderColor: theme.border }]}
                    onPress={handleSkipNext}>
                    <ThemedText style={[styles.queueControlText, { color: theme.text }]}>⏭ Next</ThemedText>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <SectionList
              sections={sections}
              renderItem={renderItem}
              renderSectionHeader={({ section }) => (
                <View style={[styles.sectionHeader, { backgroundColor: theme.background, borderBottomColor: theme.border }]}>
                  <ThemedText style={[styles.sectionHeaderText, { color: theme.mutedText }]}>
                    {section.title}
                  </ThemedText>
                </View>
              )}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled
            />
          </>
        )}
      </ThemedView>

      <Modal
        visible={!!viewTextItem}
        transparent
        animationType="fade"
        onRequestClose={() => setViewTextItem(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.surface }]}>
            <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
              <ThemedText style={[styles.modalTitle, { color: theme.text }]} numberOfLines={1}>
                {viewTextItem?.title}
              </ThemedText>
              <View style={styles.modalHeaderActions}>
                {viewTextItem?.kind === 'custom' && (
                  <TouchableOpacity
                    onPress={() => viewTextItem && openEditTitle(viewTextItem)}
                    style={styles.modalEditBtn}>
                    <ThemedText style={[styles.editIcon, { color: theme.mutedText }]}>✏️</ThemedText>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => setViewTextItem(null)}
                  style={styles.modalClose}>
                  <ThemedText style={[styles.modalCloseText, { color: theme.mutedText }]}>Close</ThemedText>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView
              style={styles.modalScroll}
              contentContainerStyle={styles.modalScrollContent}
              showsVerticalScrollIndicator={false}>
              <ThemedText style={[styles.modalBody, { color: theme.text }]}>
                {viewTextItem?.text ?? ''}
              </ThemedText>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!editItem}
        transparent
        animationType="fade"
        onRequestClose={() => setEditItem(null)}>
        <View style={styles.modalOverlay}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.editModalContent}>
            <View style={[styles.editModalCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <ThemedText style={[styles.editModalLabel, { color: theme.mutedText }]}>Title</ThemedText>
              <TextInput
                style={[styles.editModalInput, { color: theme.text, borderColor: theme.border }]}
                placeholder="Pep title"
                placeholderTextColor={theme.mutedText}
                value={editTitleDraft}
                onChangeText={setEditTitleDraft}
                autoFocus
                maxLength={80}
              />
              <View style={styles.editModalActions}>
                <TouchableOpacity
                  style={[styles.editModalBtn, { borderColor: theme.border }]}
                  onPress={() => setEditItem(null)}>
                  <ThemedText style={[styles.editModalBtnText, { color: theme.text }]}>Cancel</ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.editModalBtn, styles.editModalBtnPrimary, { backgroundColor: theme.accentWarm }]}
                  onPress={saveEditTitle}>
                  <ThemedText style={[styles.editModalBtnText, { color: theme.background }]}>Save</ThemedText>
                </TouchableOpacity>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  inner: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 14, marginTop: 4 },
  list: { paddingHorizontal: 20, paddingBottom: 100 },
  skippedBanner: {
    marginHorizontal: 20,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  skippedText: { fontSize: 13 },
  playAllRow: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  playAllButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  playAllButtonText: { fontSize: 16, fontWeight: '600' },
  queueBar: {
    marginHorizontal: 20,
    marginTop: 12,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  queueBarTitle: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  queueBarTrack: { fontSize: 16, fontWeight: '600', marginBottom: 2 },
  queueBarPosition: { fontSize: 13, marginBottom: 12 },
  queueControls: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  queueControlBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  queueControlText: { fontSize: 13, fontWeight: '600' },
  sectionHeader: {
    paddingVertical: 10,
    paddingTop: 16,
    borderBottomWidth: 1,
  },
  sectionHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptySub: { fontSize: 14, textAlign: 'center' },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    overflow: 'hidden',
  },
  cardHeader: { padding: 16 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitleTouch: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 18, fontWeight: '600' },
  editIconBtn: { padding: 4 },
  editIcon: { fontSize: 16 },
  cardDateRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 },
  cardDate: { fontSize: 13 },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  tagText: { fontSize: 11, fontWeight: '500' },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 16,
    paddingTop: 0,
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    minWidth: 100,
  },
  playBtn: {},
  stopBtn: { borderWidth: 1, backgroundColor: 'transparent' },
  secondaryBtn: { borderWidth: 1, backgroundColor: 'transparent' },
  deleteBtn: {},
  btnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 20,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 18, fontWeight: '600', flex: 1, marginRight: 8 },
  modalHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  modalEditBtn: { padding: 8 },
  modalClose: { padding: 8 },
  modalCloseText: { fontSize: 16, fontWeight: '600' },
  editModalContent: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  editModalCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
  },
  editModalLabel: { fontSize: 14, marginBottom: 8, fontWeight: '500' },
  editModalInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    marginBottom: 20,
  },
  editModalActions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  editModalBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 90,
    alignItems: 'center',
  },
  editModalBtnPrimary: { borderWidth: 0 },
  editModalBtnText: { fontSize: 16, fontWeight: '600' },
  modalScroll: { maxHeight: 400 },
  modalScrollContent: { padding: 20 },
  modalBody: { fontSize: 15, lineHeight: 22 },
});
