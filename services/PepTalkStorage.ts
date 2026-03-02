import AsyncStorage from '@react-native-async-storage/async-storage';

export type SavedPepTalk = {
  id: string;
  createdAt: string; // ISO date string
  title: string;
  topic?: string;
  scriptText: string;
  voice: string;
  audioFileUri: string;
  durationSeconds?: number;
  tone?: string; // easy, steady, direct, blunt, no_excuses
  tier?: string; // free, pro, flow
};

const STORAGE_KEY = 'savedPepTalks';

// Generate a lightweight title from text
export const generateTitle = (text: string, topic?: string): string => {
  // Extract first few words or key phrases
  const words = text.trim().split(/\s+/);
  const firstWords = words.slice(0, 3).join(' ');
  
  // Try to extract a topic/keyword from common motivational themes
  const topics = ['momentum', 'confidence', 'gym', 'work', 'focus', 'reset', 'start', 'consistency'];
  let detectedTopic: string | undefined;
  
  const lowerText = text.toLowerCase();
  for (const t of topics) {
    if (lowerText.includes(t)) {
      detectedTopic = t.charAt(0).toUpperCase() + t.slice(1);
      break;
    }
  }
  
  // Use provided topic, detected topic, or first words
  const finalTopic = topic || detectedTopic || firstWords;
  
  // Format: "Topic — FirstWords" or just "Topic"
  if (detectedTopic && firstWords.length > 20) {
    return `${finalTopic}`;
  }
  return `${finalTopic} — ${firstWords.substring(0, 20)}${firstWords.length > 20 ? '...' : ''}`;
};

export const PepTalkStorage = {
  // Get all saved pep talks
  async getAll(): Promise<SavedPepTalk[]> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEY);
      if (!data) return [];
      return JSON.parse(data);
    } catch (error) {
      console.error('Error loading saved pep talks:', error);
      return [];
    }
  },

  // Save a pep talk
  async save(pepTalk: Omit<SavedPepTalk, 'id' | 'createdAt' | 'title'>): Promise<SavedPepTalk> {
    try {
      const all = await this.getAll();
      const newPepTalk: SavedPepTalk = {
        ...pepTalk,
        id: `pep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        createdAt: new Date().toISOString(),
        title: generateTitle(pepTalk.scriptText, pepTalk.topic),
      };
      
      all.unshift(newPepTalk); // Add to beginning (newest first)
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      return newPepTalk;
    } catch (error) {
      console.error('Error saving pep talk:', error);
      throw error;
    }
  },

  // Delete a pep talk
  async delete(id: string): Promise<void> {
    try {
      const all = await this.getAll();
      const filtered = all.filter((pep) => pep.id !== id);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
    } catch (error) {
      console.error('Error deleting pep talk:', error);
      throw error;
    }
  },

  // Get a single pep talk by ID
  async getById(id: string): Promise<SavedPepTalk | null> {
    try {
      const all = await this.getAll();
      return all.find((pep) => pep.id === id) || null;
    } catch (error) {
      console.error('Error getting pep talk:', error);
      return null;
    }
  },
};
