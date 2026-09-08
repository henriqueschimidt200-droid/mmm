import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mentalai.app',
  appName: 'Mental AI',
  webDir: 'public',
  server: { androidScheme: 'https' }
};

export default config;
