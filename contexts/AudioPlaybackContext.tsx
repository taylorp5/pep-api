import { createContext, useCallback, useContext, useRef, ReactNode } from 'react';
import { Audio } from 'expo-av';

type AudioPlaybackContextType = {
  setCurrentSound: (sound: Audio.Sound | null) => void;
  stopCurrent: () => Promise<void>;
};

const AudioPlaybackContext = createContext<AudioPlaybackContextType | undefined>(undefined);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
  const currentSoundRef = useRef<Audio.Sound | null>(null);

  const setCurrentSound = useCallback((sound: Audio.Sound | null) => {
    currentSoundRef.current = sound;
  }, []);

  const stopCurrent = useCallback(async () => {
    const sound = currentSoundRef.current;
    if (sound) {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
      } catch (e) {
        console.warn('[AudioPlayback] stopCurrent error:', e);
      }
      currentSoundRef.current = null;
    }
  }, []);

  return (
    <AudioPlaybackContext.Provider value={{ setCurrentSound, stopCurrent }}>
      {children}
    </AudioPlaybackContext.Provider>
  );
}

export function useAudioPlayback(): AudioPlaybackContextType {
  const ctx = useContext(AudioPlaybackContext);
  if (ctx === undefined) {
    throw new Error('useAudioPlayback must be used within AudioPlaybackProvider');
  }
  return ctx;
}
