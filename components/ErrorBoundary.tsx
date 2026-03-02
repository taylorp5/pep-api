import React, { Component, ReactNode } from 'react';
import { StyleSheet, View, TouchableOpacity } from 'react-native';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <ErrorFallback error={this.state.error} onReset={this.handleReset} />;
    }

    return this.props.children;
  }
}

function ErrorFallback({ error, onReset }: { error: Error | null; onReset: () => void }) {
  const tintColor = useThemeColor({}, 'tint');
  const isNetworkError =
    error?.message?.includes('Network request failed') ||
    error?.message?.includes('Failed to fetch') ||
    error?.message?.includes('Cannot connect to API');

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.content}>
        <ThemedText type="title" style={styles.title}>
          Oops! Something went wrong
        </ThemedText>

        {isNetworkError ? (
          <>
            <ThemedText style={styles.message}>
              Unable to connect to the server. Please check:
            </ThemedText>
            <ThemedView style={styles.listContainer}>
              <ThemedText style={styles.listItem}>• Your internet connection</ThemedText>
              <ThemedText style={styles.listItem}>• The API server is running</ThemedText>
              <ThemedText style={styles.listItem}>• Your device is on the same network</ThemedText>
            </ThemedView>
          </>
        ) : (
          <ThemedText style={styles.message}>
            {error?.message || 'An unexpected error occurred'}
          </ThemedText>
        )}

        <TouchableOpacity
          style={[styles.button, { backgroundColor: tintColor }]}
          onPress={onReset}>
          <ThemedText style={styles.buttonText}>Try Again</ThemedText>
        </TouchableOpacity>
      </ThemedView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
  },
  title: {
    textAlign: 'center',
    marginBottom: 8,
  },
  message: {
    fontSize: 16,
    textAlign: 'center',
    opacity: 0.7,
    marginBottom: 8,
  },
  listContainer: {
    alignItems: 'flex-start',
    marginVertical: 12,
  },
  listItem: {
    fontSize: 14,
    opacity: 0.7,
    marginVertical: 4,
  },
  button: {
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    minWidth: 120,
    marginTop: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
