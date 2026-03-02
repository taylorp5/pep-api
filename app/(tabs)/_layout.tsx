import { Tabs } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { pepTheme } from '@/constants/pep-theme';

const TAB_ACTIVE_GOLD = '#C9A227';
const TAB_INACTIVE = 'rgba(168, 173, 181, 0.8)';

export default function TabLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: TAB_ACTIVE_GOLD,
        tabBarInactiveTintColor: TAB_INACTIVE,
        tabBarStyle: [
          styles.tabBar,
          Platform.OS === 'android' && styles.tabBarAndroid,
          {
            backgroundColor: pepTheme.surface,
            paddingBottom: insets.bottom,
            paddingTop: 12,
          },
        ],
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarButton: HapticTab,
        tabBarIconStyle: styles.tabBarIcon,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <IconSymbol
              name="house.fill"
              size={24}
              color={focused ? TAB_ACTIVE_GOLD : color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Library',
          tabBarIcon: ({ color, focused }) => (
            <IconSymbol
              name="book.fill"
              size={24}
              color={focused ? TAB_ACTIVE_GOLD : color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <IconSymbol
              name="person.fill"
              size={24}
              color={focused ? TAB_ACTIVE_GOLD : color}
            />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    borderTopWidth: 0,
    elevation: 0,
    shadowOpacity: 0,
  },
  tabBarAndroid: {
    elevation: 0,
  },
  tabBarLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  tabBarIcon: {
    marginBottom: -2,
  },
});
