/**
 * 宿主侧唯一的语音面：桌宠只显示在桌面端，这一句也只由桌面端念。
 * @module dsh-pet/src/host/voice-target
 */

/** 一次说话该由哪一端念。 */
export type VoiceTarget = 'desktop';

/** 语音播给的那一端。 */
export const VOICE_TARGET: VoiceTarget = 'desktop';
