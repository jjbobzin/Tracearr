/**
 * Poller Utility Functions Tests
 *
 * Tests pure utility functions from poller/utils.ts:
 * - isPrivateIP: Detect private/local IP addresses
 * - parseJellyfinClient: Extract client info from Jellyfin user agent
 */

import { describe, it, expect } from 'vitest';
import { isPrivateIP, parseJellyfinClient } from '../utils.js';

describe('isPrivateIP', () => {
  describe('IPv4 private ranges', () => {
    it('should detect 10.x.x.x as private (10.0.0.0/8)', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('10.255.255.255')).toBe(true);
      expect(isPrivateIP('10.123.45.67')).toBe(true);
    });

    it('should detect 172.16-31.x.x as private (172.16.0.0/12)', () => {
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('172.31.255.255')).toBe(true);
      expect(isPrivateIP('172.20.10.5')).toBe(true);
    });

    it('should NOT detect 172.15.x.x or 172.32.x.x as private', () => {
      expect(isPrivateIP('172.15.0.1')).toBe(false);
      expect(isPrivateIP('172.32.0.1')).toBe(false);
    });

    it('should detect 192.168.x.x as private (192.168.0.0/16)', () => {
      expect(isPrivateIP('192.168.0.1')).toBe(true);
      expect(isPrivateIP('192.168.1.1')).toBe(true);
      expect(isPrivateIP('192.168.255.255')).toBe(true);
    });

    it('should detect 127.x.x.x as private (loopback)', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('127.255.255.255')).toBe(true);
    });

    it('should detect 169.254.x.x as private (link-local)', () => {
      expect(isPrivateIP('169.254.0.1')).toBe(true);
      expect(isPrivateIP('169.254.255.255')).toBe(true);
    });

    it('should detect 0.x.x.x as private (current network)', () => {
      expect(isPrivateIP('0.0.0.0')).toBe(true);
      expect(isPrivateIP('0.1.2.3')).toBe(true);
    });
  });

  describe('IPv4 public addresses', () => {
    it('should NOT detect public IPs as private', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false); // Google DNS
      expect(isPrivateIP('1.1.1.1')).toBe(false); // Cloudflare DNS
      expect(isPrivateIP('142.250.80.46')).toBe(false); // Google
      expect(isPrivateIP('151.101.1.140')).toBe(false); // Reddit
      expect(isPrivateIP('203.0.113.50')).toBe(false); // Documentation range but public
    });
  });

  describe('IPv6 private ranges', () => {
    it('should detect ::1 as private (loopback)', () => {
      expect(isPrivateIP('::1')).toBe(true);
    });

    it('should detect fe80: as private (link-local)', () => {
      expect(isPrivateIP('fe80::1')).toBe(true);
      expect(isPrivateIP('fe80:0:0:0:0:0:0:1')).toBe(true);
      expect(isPrivateIP('FE80::abcd:1234')).toBe(true); // Case insensitive
    });

    it('should detect fc/fd as private (unique local)', () => {
      expect(isPrivateIP('fc00::1')).toBe(true);
      expect(isPrivateIP('fd00::1')).toBe(true);
      expect(isPrivateIP('fdab:cdef:1234::1')).toBe(true);
    });
  });

  describe('IPv6 public addresses', () => {
    it('should NOT detect public IPv6 as private', () => {
      expect(isPrivateIP('2001:4860:4860::8888')).toBe(false); // Google DNS
      expect(isPrivateIP('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
    });
  });

  describe('edge cases', () => {
    it('should treat empty string as private', () => {
      expect(isPrivateIP('')).toBe(true);
    });

    it('should treat null-like values as private', () => {
      expect(isPrivateIP(null as unknown as string)).toBe(true);
      expect(isPrivateIP(undefined as unknown as string)).toBe(true);
    });
  });
});

describe('parseJellyfinClient', () => {
  describe('iOS devices', () => {
    it('should parse "Jellyfin iOS" as iOS/iPhone', () => {
      const result = parseJellyfinClient('Jellyfin iOS');
      expect(result.platform).toBe('iOS');
      expect(result.device).toBe('iPhone');
    });

    it('should parse clients containing "iphone" as iOS/iPhone', () => {
      const result = parseJellyfinClient('Jellyfin for iPhone');
      expect(result.platform).toBe('iOS');
      expect(result.device).toBe('iPhone');
    });

    it('should parse "Jellyfin iPad" as iOS/iPad', () => {
      const result = parseJellyfinClient('Jellyfin iPad');
      expect(result.platform).toBe('iOS');
      expect(result.device).toBe('iPad');
    });

    it('should be case insensitive for iOS detection', () => {
      expect(parseJellyfinClient('jellyfin IOS').platform).toBe('iOS');
      expect(parseJellyfinClient('JELLYFIN iOS').platform).toBe('iOS');
    });
  });

  describe('Android devices', () => {
    it('should parse "Jellyfin Android" as Android/Android', () => {
      const result = parseJellyfinClient('Jellyfin Android');
      expect(result.platform).toBe('Android');
      expect(result.device).toBe('Android');
    });

    it('should parse Android TV clients as Android TV', () => {
      const result = parseJellyfinClient('Jellyfin Android TV');
      expect(result.platform).toBe('Android TV');
      expect(result.device).toBe('Android TV');
    });

    it('should parse Shield clients as Android TV', () => {
      const result = parseJellyfinClient('Jellyfin for Shield');
      expect(result.platform).toBe('Android TV');
      expect(result.device).toBe('Android TV');
    });

    it('should parse NVIDIA Shield with Android in name', () => {
      const result = parseJellyfinClient('Jellyfin Android Shield');
      expect(result.platform).toBe('Android TV');
      expect(result.device).toBe('Android TV');
    });

    it('should parse just "Shield" as Android TV', () => {
      const result = parseJellyfinClient('Shield');
      expect(result.platform).toBe('Android TV');
      expect(result.device).toBe('Android TV');
    });
  });

  describe('Smart TVs', () => {
    it('should parse Samsung/Tizen clients as Samsung TV', () => {
      expect(parseJellyfinClient('Jellyfin Samsung')).toEqual({
        platform: 'Tizen',
        device: 'Samsung TV',
      });
      expect(parseJellyfinClient('Jellyfin Tizen')).toEqual({
        platform: 'Tizen',
        device: 'Samsung TV',
      });
    });

    it('should parse LG/webOS clients as LG TV', () => {
      expect(parseJellyfinClient('Jellyfin webOS')).toEqual({
        platform: 'webOS',
        device: 'LG TV',
      });
      expect(parseJellyfinClient('Jellyfin LG')).toEqual({
        platform: 'webOS',
        device: 'LG TV',
      });
    });

    it('should parse Roku clients as Roku', () => {
      expect(parseJellyfinClient('Jellyfin Roku')).toEqual({
        platform: 'Roku',
        device: 'Roku',
      });
    });
  });

  describe('Apple TV', () => {
    it('should parse tvOS clients as Apple TV', () => {
      expect(parseJellyfinClient('Jellyfin tvOS')).toEqual({
        platform: 'tvOS',
        device: 'Apple TV',
      });
    });

    it('should parse "Apple TV" in client name as Apple TV', () => {
      expect(parseJellyfinClient('Jellyfin Apple TV')).toEqual({
        platform: 'tvOS',
        device: 'Apple TV',
      });
    });

    it('should parse Swiftfin as Apple TV', () => {
      expect(parseJellyfinClient('Swiftfin')).toEqual({
        platform: 'tvOS',
        device: 'Apple TV',
      });
    });
  });

  describe('Web browsers', () => {
    it('should parse "Jellyfin Web" as Web/Browser', () => {
      expect(parseJellyfinClient('Jellyfin Web')).toEqual({
        platform: 'Web',
        device: 'Browser',
      });
    });
  });

  describe('Media players', () => {
    it('should parse Kodi clients as Kodi', () => {
      expect(parseJellyfinClient('Kodi')).toEqual({
        platform: 'Kodi',
        device: 'Kodi',
      });
      expect(parseJellyfinClient('Jellyfin for Kodi')).toEqual({
        platform: 'Kodi',
        device: 'Kodi',
      });
    });

    it('should parse Infuse clients as Infuse', () => {
      expect(parseJellyfinClient('Infuse')).toEqual({
        platform: 'Infuse',
        device: 'Infuse',
      });
    });
  });

  describe('deviceType parameter', () => {
    it('should use deviceType when provided and meaningful', () => {
      const result = parseJellyfinClient('Custom Client', 'Smart TV');
      expect(result.platform).toBe('Custom Client');
      expect(result.device).toBe('Smart TV');
    });

    it('should ignore deviceType when empty', () => {
      const result = parseJellyfinClient('Jellyfin iOS', '');
      expect(result.platform).toBe('iOS');
      expect(result.device).toBe('iPhone');
    });

    it('should ignore deviceType when "Unknown"', () => {
      const result = parseJellyfinClient('Jellyfin Android', 'Unknown');
      expect(result.platform).toBe('Android');
      expect(result.device).toBe('Android');
    });

    it('should prefer deviceType over parsing when deviceType is meaningful', () => {
      const result = parseJellyfinClient('Jellyfin iOS', 'Custom Device');
      expect(result.device).toBe('Custom Device');
    });
  });

  describe('fallback behavior', () => {
    it('should use client name as fallback for unknown clients', () => {
      const result = parseJellyfinClient('Unknown Client App');
      expect(result.platform).toBe('Unknown Client App');
      expect(result.device).toBe('Unknown Client App');
    });

    it('should handle empty client string', () => {
      const result = parseJellyfinClient('');
      expect(result.platform).toBe('Unknown');
      expect(result.device).toBe('Unknown');
    });
  });
});
