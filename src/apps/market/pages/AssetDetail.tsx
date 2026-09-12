import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../../../lib/i18n';
import { useFavorites } from '../../../hooks/useFavorites';
import { useDdpSubscription } from '../../../hooks/useDdpSubscription';
import { useCollection } from '../../../hooks/useCollection';
import { DDP_CONFIG } from '../../../config/ddpConfig';
import { 
  parseMongoId, 
  parseMongoTime, 
  formatSmartDateTime,
  formatSignificantPrice, 
  type BalanceDoc, 
  type TransferDoc, 
  type FillOrderDoc, 
  type AssetRankingsData 
} from '../../../types/models';
import { ddpPool } from '../../../lib/ddp/ddpSubPool';

export const AssetDetail: React.FC = () => {
  const { assetName } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { favs, toggleFavorite, isFavorite } = useFavorites();

  const cleanedAsset = assetName ? assetName.trim().toUpperCase() : 'BTS';
  const [assetSearch, setAssetSearch] = useState('');

  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.BALANCE, { 'a': cleanedAsset });
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.TRANSFER, { 'a': cleanedAsset });
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.FILL_ORDER, { 'a': cleanedAsset });

  // 持仓大户富豪榜仅显示前 10 个
  const holders = useCollection<BalanceDoc>(
    DDP_CONFIG.COLLECTIONS.BALANCE,
    b => b.a === cleanedAsset,
    (a, b) => (b.b || 0) - (a.b || 0)
  ).slice(0, 10);

  const transfers = useCollection<TransferDoc>(
    DDP_CONFIG.COLLECTIONS.TRANSFER,
    tx => tx.a === cleanedAsset,
    (a, b) => parseMongoTime(b.T) - parseMongoTime(a.T)
  );

  const rawTrades = useCollection<FillOrderDoc>(
    DDP_CONFIG.COLLECTIONS.FILL_ORDER,
    tr => tr.a?.includes(cleanedAsset),
    (a, b) => parseMongoTime(b.T) - parseMongoTime(a.T)
  );

  // 🌟 核心改进：最新成交以当前资产作为基准计价货币（Base），只展示对方资产，并换算其以当前资产计价的价格
  const processedTrades = rawTrades.map(tr => {
    if (!tr.a || tr.a.length < 2) return null;
    const isFirstCurrent = tr.a[0] === cleanedAsset;
    const counterAsset = isFirstCurrent ? tr.a[1] : tr.a[0];

    // 计算价格：1 对方资产 = X 当前资产 (amountCurrent / amountCounter)
    let priceInCurrent = 0;
    if (tr.b && tr.b.length >= 2 && tr.b[0] > 0 && tr.b[1] > 0) {
      const currentAmt = isFirstCurrent ? tr.b[0] : tr.b[1];
      const counterAmt = isFirstCurrent ? tr.b[1] : tr.b[0];
      priceInCurrent = currentAmt / counterAmt;
    } else if (tr.p) {
      priceInCurrent = isFirstCurrent ? (1 / tr.p) : tr.p;
    }

    return {
      ...tr,
      counterAsset,
      priceInCurrent,
      jumpMarketPair: `${counterAsset}_${cleanedAsset}`
    };
  }).filter(Boolean);

  const [assetRankings, setAssetRankings] = useState<AssetRankingsData>({
    topTraders: [],
    topRelatedAssets: []
  });

  useEffect(() => {
    const fetchAssetRankings = async () => {
      try {
        const res = await ddpPool.call(DDP_CONFIG.METHODS.GET_ASSET_RANKINGS, cleanedAsset);
        if (res) setAssetRankings(res);
      } catch {}
    };
    fetchAssetRankings();
  }, [cleanedAsset]);

  const isFav = isFavorite('assets', cleanedAsset);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (assetSearch.trim()) {
      navigate(`/asset/${assetSearch.trim().toUpperCase()}`);
      setAssetSearch('');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in pb-16 md:pb-0 text-sm">
      
      {/* 头部控制栏 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 md:p-6 shadow-sm flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-black text-amber-500 flex items-center gap-2">
            <span>🪙 {cleanedAsset}</span>
            <button
              onClick={() => toggleFavorite('assets', cleanedAsset)}
              className={`text-xl cursor-pointer transition ${isFav ? 'text-amber-500' : 'text-gray-400'}`}
              title="收藏资产"
            >
              {isFav ? '★' : '☆'}
            </button>
          </h2>

          <select
            value={cleanedAsset}
            onChange={(e) => navigate(`/asset/${e.target.value}`)}
            className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-1.5 text-xs font-bold font-mono outline-none"
          >
            {Array.from(new Set(['BTS', 'CNY', 'USD', ...favs.assets])).map(symbol => (
              <option key={symbol} value={symbol}>
                {isFavorite('assets', symbol) ? '★' : '•'} {symbol}
              </option>
            ))}
          </select>
        </div>

        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            placeholder={t.searchAssetPlaceholder}
            value={assetSearch}
            onChange={(e) => setAssetSearch(e.target.value)}
            className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-1.5 text-xs font-mono focus:outline-none focus:border-blue-500 uppercase"
          />
          <button type="submit" className="bg-amber-600 hover:bg-amber-700 text-white font-bold px-3 py-1.5 rounded-xl text-xs cursor-pointer">
            {t.searchBtn}
          </button>
        </form>
      </div>

      {/* 最高交易用户 & 最高关联资产对 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm">
          <h3 className="text-xs font-bold text-blue-500 mb-3 uppercase tracking-wider">🏆 本资产交易量最高用户</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {assetRankings.topTraders.length === 0 ? <p className="text-xs text-gray-400 py-3">{t.noData}</p> : assetRankings.topTraders.map(item => (
              <div key={item.username} className="flex justify-between items-center text-xs py-1 font-mono border-b border-gray-100 dark:border-gray-800/40">
                <Link to={`/user/${item.username}`} className="text-blue-500 hover:underline">👤 {item.username}</Link>
                <b className="text-emerald-500">{item.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} {cleanedAsset}</b>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm">
          <h3 className="text-xs font-bold text-amber-500 mb-3 uppercase tracking-wider">🔥 与本资产关联最高交易资产</h3>
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {assetRankings.topRelatedAssets.length === 0 ? <p className="text-xs text-gray-400 py-3">{t.noData}</p> : assetRankings.topRelatedAssets.map(item => (
              <div key={item.asset} className="flex justify-between items-center text-xs py-1 font-mono border-b border-gray-100 dark:border-gray-800/40">
                <Link to="/market" state={{ jumpPair: `${cleanedAsset}_${item.asset}` }} className="text-amber-500 hover:underline">⚡ {cleanedAsset}/{item.asset}</Link>
                <b className="text-blue-500">{item.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })} {cleanedAsset}</b>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 核心三栏：大户持仓 (Top 10)、转账记录、最新成交 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* 大户持仓榜 (Top 10) */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm">
          <h3 className="text-xs font-bold text-blue-500 mb-3 uppercase tracking-wider">📊 {t.richList} (Top 10)</h3>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {holders.length === 0 ? (
              <p className="text-xs text-gray-400 py-3 text-center">{t.noData}</p>
            ) : holders.map((h, idx) => (
              <div key={parseMongoId(h._id)} className="flex justify-between items-center text-xs py-1 font-mono border-b border-gray-100 dark:border-gray-800/40">
                <span className="flex items-center gap-1.5 truncate">
                  <span className={`w-4 h-4 rounded text-[10px] flex items-center justify-center font-bold ${idx < 3 ? 'bg-amber-500 text-white' : 'bg-gray-200 dark:bg-gray-800 text-gray-500'}`}>{idx + 1}</span>
                  <Link to={`/user/${h.u}`} className="text-blue-500 hover:underline truncate">{h.u}</Link>
                </span>
                <b className="text-gray-800 dark:text-gray-200">{h.b?.toLocaleString()}</b>
              </div>
            ))}
          </div>
        </div>

        {/* 转账记录 (From / To分两列，带完整年月日时间) */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm flex flex-col">
          <h3 className="text-xs font-bold text-emerald-500 mb-3 uppercase tracking-wider">💸 {t.transfers} ({transfers.length})</h3>
          
          <div className="grid grid-cols-12 text-[11px] text-gray-400 font-bold border-b border-gray-200 dark:border-gray-800 pb-1.5 mb-1.5">
            <span className="col-span-4">{t.time}</span>
            <span className="col-span-3">From</span>
            <span className="col-span-2">To</span>
            <span className="col-span-3 text-right">{t.amount}</span>
          </div>

          <div className="space-y-2 max-h-80 overflow-y-auto pr-1 font-mono text-xs">
            {transfers.map(tx => {
              const dt = formatSmartDateTime(tx.T);
              return (
                <div key={parseMongoId(tx._id)} className="grid grid-cols-12 py-1 items-center border-b border-gray-100 dark:border-gray-800/40">
                  <div className="col-span-4 flex flex-col" title={dt.fullStr}>
                    <span className="text-gray-700 dark:text-gray-300 font-mono text-[11px] leading-tight">{dt.dateStr}</span>
                    <span className="text-gray-400 text-[10px] leading-tight">{dt.timeStr}</span>
                  </div>
                  <Link to={`/user/${tx.u?.[0]}`} className="col-span-3 text-blue-500 hover:underline truncate font-bold" title={tx.u?.[0]}>
                    {tx.u?.[0]}
                  </Link>
                  <Link to={`/user/${tx.u?.[1]}`} className="col-span-2 text-gray-500 dark:text-gray-400 hover:underline truncate" title={tx.u?.[1]}>
                    {tx.u?.[1]}
                  </Link>
                  <span className="col-span-3 text-right font-bold text-emerald-500 truncate">
                    {tx.b}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 🌟 核心改进：最新成交只显示对方资产，价格把当前资产作为Base定价，带年月日时间 */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm flex flex-col">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-xs font-bold text-red-500 uppercase tracking-wider">🛒 {t.recentMatches} ({processedTrades.length})</h3>
            <span className="text-[10px] text-gray-400">计价: 1 资产 = X {cleanedAsset}</span>
          </div>
          
          <div className="grid grid-cols-12 text-[11px] text-gray-400 font-bold border-b border-gray-200 dark:border-gray-800 pb-1.5 mb-1.5">
            <span className="col-span-4">{t.time}</span>
            <span className="col-span-4">交易资产</span>
            <span className="col-span-4 text-right">价格 ({cleanedAsset})</span>
          </div>

          <div className="space-y-2 max-h-80 overflow-y-auto pr-1 font-mono text-xs">
            {processedTrades.length === 0 ? (
              <p className="text-xs text-gray-400 py-6 text-center">{t.noData}</p>
            ) : processedTrades.map(tr => {
              const dt = formatSmartDateTime(tr!.T);
              return (
                <div key={parseMongoId(tr!._id)} className="grid grid-cols-12 py-1 items-center border-b border-gray-100 dark:border-gray-800/40">
                  <div className="col-span-4 flex flex-col" title={dt.fullStr}>
                    <span className="text-gray-700 dark:text-gray-300 font-mono text-[11px] leading-tight">{dt.dateStr}</span>
                    <span className="text-gray-400 text-[10px] leading-tight">{dt.timeStr}</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => navigate('/market', { state: { jumpPair: tr!.jumpMarketPair } })}
                    className="col-span-4 text-left font-bold text-blue-500 hover:underline truncate cursor-pointer"
                    title={`前往 ${tr!.counterAsset}/${cleanedAsset} 交易市场`}
                  >
                    🪙 {tr!.counterAsset}
                  </button>

                  <b className="col-span-4 text-right text-red-500 truncate" title={`1 ${tr!.counterAsset} = ${tr!.priceInCurrent} ${cleanedAsset}`}>
                    {formatSignificantPrice(tr!.priceInCurrent)}
                  </b>
                </div>
              );
            })}
          </div>
        </div>

      </div>

    </div>
  );
};