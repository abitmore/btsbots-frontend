import { useState, useEffect, useCallback } from 'react';
import { ddpPool } from '../lib/ddp/ddpSubPool';
import { DDP_CONFIG } from '../config/ddpConfig';
import { useAuth } from './useAuth';

export interface FavoritesStore {
  markets: string[];
  assets: string[];
  users: string[];
}

const DEFAULT_FAVORITES: FavoritesStore = {
  markets: ['BTS_CNY', 'BTS_USD'],
  assets: ['BTS', 'CNY', 'USD'],
  users: []
};

// 规范化市场与资产命名
function normalizeItem(type: 'markets' | 'assets' | 'users', item: string): string {
  if (type === 'markets') {
    return item.toUpperCase().replace('/', '_').trim();
  }
  if (type === 'assets') {
    return item.toUpperCase().trim();
  }
  return item.toLowerCase().trim();
}

export function useFavorites() {
  const { isLoggedIn, currentAccount } = useAuth();
  
  // 🌟 1. 按当前账号隔离存储 Key，防止不同账号或未登录状态本地数据串扰
  const storageKey = `btsbots_fav_${currentAccount ? currentAccount.toLowerCase() : 'guest'}`;

  const [favs, setFavs] = useState<FavoritesStore>(() => {
    try {
      const val = localStorage.getItem(storageKey);
      if (val) {
        const parsed = JSON.parse(val);
        return {
          markets: Array.isArray(parsed.markets) ? parsed.markets : DEFAULT_FAVORITES.markets,
          assets: Array.isArray(parsed.assets) ? parsed.assets : DEFAULT_FAVORITES.assets,
          users: Array.isArray(parsed.users) ? parsed.users : DEFAULT_FAVORITES.users
        };
      }
    } catch {}
    return DEFAULT_FAVORITES;
  });

  // 🌟 2. 账号切换时，立即重载对应账号的本地缓存
  useEffect(() => {
    try {
      const val = localStorage.getItem(storageKey);
      if (val) {
        setFavs(JSON.parse(val));
      } else {
        setFavs(DEFAULT_FAVORITES);
      }
    } catch {
      setFavs(DEFAULT_FAVORITES);
    }
  }, [storageKey]);

  // 🌟 3. 从服务器同步：以云端最新真实数据为准覆写（而不是并集污染）
  const syncServerFavorites = useCallback(async () => {
    if (!isLoggedIn || !currentAccount) return;
    try {
      // 兼容两种常见的后端 RPC 签名
      let serverFavs = await ddpPool.call<FavoritesStore>('getFavorites');
      if (!serverFavs) {
        serverFavs = await ddpPool.call<FavoritesStore>('getMyFavorites');
      }

      if (serverFavs && typeof serverFavs === 'object') {
        const cleanServerData: FavoritesStore = {
          markets: Array.isArray(serverFavs.markets) 
            ? Array.from(new Set(serverFavs.markets.map(m => normalizeItem('markets', m)))) 
            : DEFAULT_FAVORITES.markets,
          assets: Array.isArray(serverFavs.assets) 
            ? Array.from(new Set(serverFavs.assets.map(a => normalizeItem('assets', a)))) 
            : DEFAULT_FAVORITES.assets,
          users: Array.isArray(serverFavs.users) 
            ? Array.from(new Set(serverFavs.users.map(u => normalizeItem('users', u)))) 
            : []
        };

        // 直接采用服务器真理源，同步更新本地存储
        setFavs(cleanServerData);
        localStorage.setItem(storageKey, JSON.stringify(cleanServerData));
      }
    } catch (err) {
      console.warn('[Favorites] 同步云端收藏失败:', err);
    }
  }, [isLoggedIn, currentAccount, storageKey]);

  useEffect(() => {
    syncServerFavorites();
  }, [syncServerFavorites]);

  // 🌟 4. 切换收藏状态：本地即时响应 + 云端 RPC 持久化
  const toggleFavorite = async (type: 'markets' | 'assets' | 'users', item: string) => {
    const cleanItem = normalizeItem(type, item);
    const list = favs[type] || [];
    const exists = list.includes(cleanItem);
    const nextList = exists ? list.filter(i => i !== cleanItem) : [...list, cleanItem];

    const nextState = {
      ...favs,
      [type]: nextList
    };

    setFavs(nextState);
    localStorage.setItem(storageKey, JSON.stringify(nextState));

    if (isLoggedIn) {
      const rpcMethod = exists ? DDP_CONFIG.METHODS.REMOVE_FAVORITE : DDP_CONFIG.METHODS.ADD_FAVORITE;
      try {
        await ddpPool.call(rpcMethod, type, cleanItem);
      } catch (err) {
        console.warn(`[Favorites] 远程同步 ${rpcMethod} 失败:`, err);
      }
    }
  };

  const isFavorite = (type: 'markets' | 'assets' | 'users', item: string): boolean => {
    const cleanItem = normalizeItem(type, item);
    return (favs[type] || []).includes(cleanItem);
  };

  return {
    favs,
    toggleFavorite,
    isFavorite,
    reloadFavorites: syncServerFavorites
  };
}