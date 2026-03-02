declare module 'react-native-fetch-api' {
  export function fetch(
    input: RequestInfo | URL,
    init?: RequestInit & { reactNative?: { textStreaming?: boolean } }
  ): Promise<Response>;
  export { Headers, Request, Response };
}
