import { useState, useEffect, useRef } from 'react';
import { StyleSheet, TouchableOpacity, Alert, FlatList, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Audio } from 'expo-av';
import { useCallback } from 'react';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { loadSavedPeps, deletePep, type PepItem } from '@/services/PepLibrary';
import { useUser } from '@/contexts/UserContext';
import { useAudioPlayback } from '@/contexts/AudioPlaybackContext';

// Premium dark theme colors (matching home screen)
const theme = {
  background: '#141722',
  surface: '#1E2230',
  surfaceSoft: '#262B3A',
  border: 'rgba(255,255,255,0.08)',
  text: '#FFFFFF',
  mutedText: '#A8ADB5',
  accent: '#E6E8EB',
  error: '#FF4444',
};

// Tone label mapping
const TONE_LABELS: Record<string, string> = {
  easy: 'Easy',
  steady: 'Steady',
  direct: 'Direct',
  blunt: 'Blunt',
  no_excuses: 'No excuses',
};

// Map PepItem to legacy shape for this screen's existing UI
type LibraryItem = PepItem & {
  createdAt: string;
  scriptText: string;
  audioFileUri: string;
  voice: string;
  durationSeconds?: number;
  tone?: string;
};
function toLibraryItem(p: PepItem): LibraryItem {
  return {
    ...p,
    createdAt: new Date(p.createdAt).toISOString(),
    scriptText: p.text ?? '',
    audioFileUri: p.audioUriLocal,
    voice: p.voiceProfileId,
    durationSeconds: p.lengthSecondsRequested,
    tone: typeof p.intensityLevel === 'string' ? p.intensityLevel : String(p.intensityLevel),
  };
}

export default function LibraryScreen() {
  const router = useRouter();
  const { entitlement } = useUser();
  const { stopCurrent } = useAudioPlayback();
  const isFlow = entitlement === 'flow';
  
  const [savedPepTalks, setSavedPepTalks] = useState<LibraryItem[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  
  // Autoplay queue state (Flow only)
  const [playQueue, setPlayQueue] = useState<LibraryItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isAutoplaying, setIsAutoplaying] = useState(false);
  const autoplaySoundRef = useRef<Audio.Sound | null>(null);

  // Stop playback when screen loses focus (navigating away)
  useFocusEffect(
    useCallback(() => {
      return () => {
        // Cleanup: stop and unload audio when navigating away
        if (sound) {
          sound.stopAsync().catch(console.error);
          sound.unloadAsync().catch(console.error);
          setSound(null);
          setPlayingId(null);
        }
        // Stop autoplay if active
        if (autoplaySoundRef.current) {
          autoplaySoundRef.current.stopAsync().catch(console.error);
          autoplaySoundRef.current.unloadAsync().catch(console.error);
          autoplaySoundRef.current = null;
        }
        setIsAutoplaying(false);
        setCurrentIndex(-1);
        setPlayQueue([]);
      };
    }, [sound])
  );

  useEffect(() => {
    loadPepTalks();
  }, []);

  // Cleanup sound on unmount
  useEffect(() => {
    return () => {
      if (sound) {
        sound.unloadAsync().catch(console.error);
      }
      if (autoplaySoundRef.current) {
        autoplaySoundRef.current.unloadAsync().catch(console.error);
        autoplaySoundRef.current = null;
      }
    };
  }, [sound]);

  const loadPepTalks = async () => {
    const items = await loadSavedPeps();
    setSavedPepTalks(items.map(toLibraryItem));
  };

  // Stop all autoplay (defined early so it can be called by other functions)
  const handleStopAll = async () => {
    console.log('[AUTOPLAY] Stopping all');
    
    // Stop autoplay sound
    if (autoplaySoundRef.current) {
      try {
        await autoplaySoundRef.current.stopAsync();
        await autoplaySoundRef.current.unloadAsync();
      } catch (err) {
        console.error('[AUTOPLAY] Error stopping:', err);
      }
      autoplaySoundRef.current = null;
    }

    // Stop manual playback
    if (sound) {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
      } catch (err) {
        console.error('Error stopping manual playback:', err);
      }
      setSound(null);
    }

    setIsAutoplaying(false);
    setCurrentIndex(-1);
    setPlayQueue([]);
    setPlayingId(null);
  };

  const handlePlay = async (pepTalk: LibraryItem) => {
    try {
      await stopCurrent();
      // Stop autoplay if active
      if (isAutoplaying) {
        await handleStopAll();
      }

      // If same audio is playing, toggle pause
      if (sound && playingId === pepTalk.id) {
        const status = await sound.getStatusAsync();
        if (status.isLoaded) {
          if (status.isPlaying) {
            await sound.pauseAsync();
            setPlayingId(null);
          } else {
            await sound.playAsync();
            setPlayingId(pepTalk.id);
          }
          return;
        }
      }

      // Stop any currently playing audio
      if (sound) {
        await sound.unloadAsync();
        setSound(null);
        setPlayingId(null);
      }

      // Load and play the saved audio file
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: pepTalk.audioUri },
        { shouldPlay: true }
      );

      setSound(newSound);
      setPlayingId(pepTalk.id);

      // Handle playback status
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded) {
          if (status.didJustFinish) {
            setPlayingId(null);
          }
        }
      });
    } catch (err) {
      console.error('Playback Error:', err);
      Alert.alert('Error', 'Failed to play audio. The file may have been deleted.');
    }
  };

  // Autoplay: Play next in queue
  const playNextInQueue = async () => {
    if (currentIndex < 0 || currentIndex >= playQueue.length - 1) {
      // Queue finished
      console.log('[AUTOPLAY] Queue finished');
      setIsAutoplaying(false);
      setCurrentIndex(-1);
      setPlayQueue([]);
      if (autoplaySoundRef.current) {
        autoplaySoundRef.current = null;
      }
      return;
    }

    const nextIndex = currentIndex + 1;
    const nextPepTalk = playQueue[nextIndex];
    
    console.log(`[AUTOPLAY] Playing ${nextIndex + 1}/${playQueue.length}: ${nextPepTalk.title}`);

    try {
      // Stop previous sound
      if (autoplaySoundRef.current) {
        await autoplaySoundRef.current.unloadAsync();
        autoplaySoundRef.current = null;
      }

      // Load and play next
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: nextPepTalk.audioFileUri },
        { shouldPlay: true }
      );

      autoplaySoundRef.current = newSound;
      setCurrentIndex(nextIndex);
      setPlayingId(nextPepTalk.id);

      // Handle playback status - auto-advance when finished
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded) {
          if (status.didJustFinish) {
            console.log(`[AUTOPLAY] Finished: ${nextPepTalk.title}`);
            setPlayingId(null);
            // Auto-advance to next
            playNextInQueue();
          }
        }
      });
    } catch (err) {
      console.error('[AUTOPLAY] Error playing next:', err);
      Alert.alert('Error', 'Failed to play next pep talk.');
      setIsAutoplaying(false);
      setCurrentIndex(-1);
      setPlayQueue([]);
    }
  };

  // Start autoplay (Flow only)
  const handlePlayAll = async () => {
    if (!isFlow || savedPepTalks.length === 0) {
      return;
    }

    // Stop any manual playback
    if (sound) {
      await sound.unloadAsync();
      setSound(null);
      setPlayingId(null);
    }

    // Create queue sorted by createdAt (oldest first for sequential playback)
    const queue = [...savedPepTalks].sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    console.log(`[AUTOPLAY] Starting queue: ${queue.length} pep talks`);
    setPlayQueue(queue);
    setCurrentIndex(0);
    setIsAutoplaying(true);

    // Start with first item
    const firstPepTalk = queue[0];
    console.log(`[AUTOPLAY] Playing 1/${queue.length}: ${firstPepTalk.title}`);

    try {
      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri: firstPepTalk.audioFileUri },
        { shouldPlay: true }
      );

      autoplaySoundRef.current = newSound;
      setPlayingId(firstPepTalk.id);

      // Handle playback status - auto-advance when finished
      newSound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded) {
          if (status.didJustFinish) {
            console.log(`[AUTOPLAY] Finished: ${firstPepTalk.title}`);
            setPlayingId(null);
            // Auto-advance to next
            playNextInQueue();
          }
        }
      });
    } catch (err) {
      console.error('[AUTOPLAY] Error starting:', err);
      Alert.alert('Error', 'Failed to start autoplay.');
      setIsAutoplaying(false);
      setCurrentIndex(-1);
      setPlayQueue([]);
    }
  };

  // Skip to next in autoplay queue
  const handleSkipNext = async () => {
    if (!isAutoplaying || currentIndex < 0) {
      return;
    }

    console.log('[AUTOPLAY] Skipping to next');
    await playNextInQueue();
  };

  const handleStop = async () => {
    if (sound) {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
        setSound(null);
        setPlayingId(null);
      } catch (err) {
        console.error('Error stopping audio:', err);
      }
    }
  };

  const handleDelete = (pepTalk: LibraryItem) => {
    Alert.alert(
      'Delete Pep Talk',
      `Are you sure you want to delete "${pepTalk.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Stop playing if this is the current audio (manual or autoplay)
              if (playingId === pepTalk.id) {
                if (sound) {
                  await sound.unloadAsync();
                  setSound(null);
                }
                if (autoplaySoundRef.current) {
                  await autoplaySoundRef.current.unloadAsync();
                  autoplaySoundRef.current = null;
                }
                setPlayingId(null);
                
                // If deleting from autoplay queue, stop autoplay
                if (isAutoplaying && playQueue.some(p => p.id === pepTalk.id)) {
                  setIsAutoplaying(false);
                  setCurrentIndex(-1);
                  setPlayQueue([]);
                }
              }

              await PepTalkStorage.delete(pepTalk.id);
              await loadPepTalks();
            } catch (error) {
              console.error('Error deleting pep talk:', error);
              Alert.alert('Error', 'Failed to delete pep talk');
            }
          },
        },
      ]
    );
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    
    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined 
    });
  };

  const formatTone = (tone?: string): string => {
    if (!tone) return '';
    return TONE_LABELS[tone] || tone;
  };

  const formatTier = (tier?: string): string => {
    if (!tier) return '';
    return tier.toUpperCase();
  };

  const renderItem = ({ item }: { item: LibraryItem }) => {
    const isPlaying = playingId === item.id;
    const isInAutoplayQueue = isAutoplaying && playQueue.some(p => p.id === item.id);
    const isCurrentInAutoplay = isAutoplaying && currentIndex >= 0 && playQueue[currentIndex]?.id === item.id;
    
    return (
      <View style={[
        styles.item, 
        { 
          backgroundColor: theme.surface, 
          borderColor: isCurrentInAutoplay ? theme.accent : theme.border,
          borderWidth: isCurrentInAutoplay ? 2 : 1,
        }
      ]}>
        <View style={styles.itemContent}>
          <View style={styles.itemHeader}>
            <ThemedText style={[styles.itemTitle, { color: theme.text }]}>
              {item.title}
              {isCurrentInAutoplay && ' ▶'}
            </ThemedText>
            <ThemedText style={[styles.itemDate, { color: theme.mutedText }]}>
              {formatDate(item.createdAt)}
            </ThemedText>
          </View>
          
          {item.topic && (
            <ThemedText style={[styles.itemTopic, { color: theme.mutedText }]}>
              Topic: {item.topic}
            </ThemedText>
          )}
          
          <ThemedText style={[styles.itemText, { color: theme.mutedText }]} numberOfLines={2}>
            {item.scriptText}
          </ThemedText>
          
          <View style={styles.itemMeta}>
            <ThemedText style={[styles.itemMetaText, { color: theme.mutedText }]}>
              {item.voice}
              {item.tone && ` • ${formatTone(item.tone)}`}
              {item.tier && ` • ${formatTier(item.tier)}`}
              {item.durationSeconds && ` • ${item.durationSeconds}s`}
            </ThemedText>
          </View>
        </View>

        <View style={styles.itemActions}>
          <TouchableOpacity
            activeOpacity={0.7}
            style={[styles.actionButton, styles.playButton, { backgroundColor: theme.accent }]}
            onPress={() => handlePlay(item)}>
            <ThemedText style={[styles.actionButtonText, { color: theme.background }]}>
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </ThemedText>
          </TouchableOpacity>
          
          {isPlaying && (
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.actionButton, styles.stopButton, { borderColor: theme.border }]}
              onPress={handleStop}>
              <ThemedText style={[styles.actionButtonText, { color: theme.text }]}>⏹ Stop</ThemedText>
            </TouchableOpacity>
          )}
          
          <TouchableOpacity
            activeOpacity={0.7}
            style={[styles.actionButton, styles.deleteButton, { backgroundColor: theme.error }]}
            onPress={() => handleDelete(item)}>
            <ThemedText style={styles.actionButtonText}>🗑 Delete</ThemedText>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <ThemedView style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Subtle ambient light overlay at top */}
      <View
        pointerEvents="none"
        style={[
          styles.ambientLight,
          { backgroundColor: 'rgba(255,255,255,0.04)' },
        ]}
      />
      
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <ThemedText style={[styles.title, { color: theme.text }]}>
          Library
        </ThemedText>
        <TouchableOpacity
          activeOpacity={0.7}
          style={[styles.closeButton, { borderColor: theme.border }]}
          onPress={() => router.back()}>
          <ThemedText style={[styles.closeButtonText, { color: theme.text }]}>Close</ThemedText>
        </TouchableOpacity>
      </View>

      {/* Flow-only autoplay controls */}
      {isFlow && savedPepTalks.length > 0 && (
        <View style={[styles.autoplayControls, { borderBottomColor: theme.border }]}>
          {!isAutoplaying ? (
            <TouchableOpacity
              activeOpacity={0.7}
              style={[styles.autoplayButton, { backgroundColor: theme.accent }]}
              onPress={handlePlayAll}>
              <ThemedText style={[styles.autoplayButtonText, { color: theme.background }]}>
                ▶ Play All
              </ThemedText>
            </TouchableOpacity>
          ) : (
            <View style={styles.autoplayActiveControls}>
              <ThemedText style={[styles.autoplayStatus, { color: theme.mutedText }]}>
                Playing {currentIndex + 1} of {playQueue.length}
              </ThemedText>
              <View style={styles.autoplayButtons}>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.autoplayControlButton, { borderColor: theme.border }]}
                  onPress={handleSkipNext}>
                  <ThemedText style={[styles.autoplayControlText, { color: theme.text }]}>
                    ⏭ Skip
                  </ThemedText>
                </TouchableOpacity>
                <TouchableOpacity
                  activeOpacity={0.7}
                  style={[styles.autoplayControlButton, { borderColor: theme.border, backgroundColor: theme.error }]}
                  onPress={handleStopAll}>
                  <ThemedText style={styles.autoplayControlText}>
                    ⏹ Stop All
                  </ThemedText>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      )}

      {savedPepTalks.length === 0 ? (
        <View style={styles.empty}>
          <ThemedText style={[styles.emptyText, { color: theme.text }]}>
            No saved pep talks yet
          </ThemedText>
          <ThemedText style={[styles.emptySubtext, { color: theme.mutedText }]}>
            Save pep talks from the home screen (Pro feature)
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={savedPepTalks}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  ambientLight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 300,
    zIndex: 0,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    paddingTop: 60,
    borderBottomWidth: 1,
    zIndex: 1,
  },
  autoplayControls: {
    padding: 16,
    borderBottomWidth: 1,
    zIndex: 1,
  },
  autoplayButton: {
    padding: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  autoplayButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  autoplayActiveControls: {
    gap: 12,
  },
  autoplayStatus: {
    fontSize: 14,
    textAlign: 'center',
  },
  autoplayButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  autoplayControlButton: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  autoplayControlText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
  },
  closeButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  closeButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  list: {
    padding: 20,
    gap: 16,
  },
  item: {
    padding: 20,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 2,
  },
  itemContent: {
    gap: 8,
  },
  itemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  itemTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
  },
  itemDate: {
    fontSize: 12,
    marginLeft: 8,
  },
  itemTopic: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
  },
  itemText: {
    fontSize: 14,
    lineHeight: 20,
  },
  itemMeta: {
    marginTop: 4,
  },
  itemMetaText: {
    fontSize: 12,
  },
  itemActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  actionButton: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  playButton: {
    // backgroundColor set dynamically
  },
  stopButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  deleteButton: {
    // backgroundColor set dynamically
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    textAlign: 'center',
  },
});
