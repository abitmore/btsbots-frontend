import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { useI18n } from '../../../lib/i18n';
import { useAuth } from '../../../hooks/useAuth';
import { useFavorites } from '../../../hooks/useFavorites';
import { useDdpSubscription } from '../../../hooks/useDdpSubscription';
import { useCollection } from '../../../hooks/useCollection';
import { DDP_CONFIG } from '../../../config/ddpConfig';
import { 
  parseMongoId, 
  parseMongoTime, 
  formatSmartDateTime,
  formatSignificantPrice,
  extractBitsharesOrderId,
  type OrderDoc, 
  type FillOrderDoc, 
  type BalanceDoc, 
  type OrderHistoryDoc, 
  type PriceDoc,
  type MarketSummaryData 
} from '../../../types/models';
import { ddpPool } from '../../../lib/ddp/ddpSubPool';
import { signerInstance } from '../../../lib/crypto/signer';

export const Market: React.FC = () => {
  const { t } = useI18n();
  const { currentAccount, isLoggedIn } = useAuth();
  const { favs, toggleFavorite, isFavorite } = useFavorites();
  const location = useLocation();

  const [currentPair, setCurrentPair] = useState<string>('BTS_CNY');
  const [searchInput, setSearchInput] = useState<string>('');
  
  useEffect(() => {
    let initial = 'BTS_CNY';
    if (location.state?.jumpPair) {
      initial = location.state.jumpPair.replace('/', '_').toUpperCase();
    }
    const [b, q] = initial.split('_');
    const inverted = `${q}_${b}`;
    if (!favs.markets.includes(initial) && favs.markets.includes(inverted)) {
      setCurrentPair(inverted);
    } else {
      setCurrentPair(initial);
    }
  }, [location.state, favs.markets]);

  const [baseAsset, quoteAsset] = currentPair.split('_');
  const databasePair = useMemo(() => [baseAsset, quoteAsset].sort().join('_'), [baseAsset, quoteAsset]);

  const [buyPrice, setBuyPrice] = useState('');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellAmount, setSellAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [summary, setSummary] = useState<MarketSummaryData>({
    price: 0, change: 0, high: 0, low: 0, volume: 0
  });

  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.ORDER_BOOK, baseAsset, quoteAsset);
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.ORDER_BOOK, quoteAsset, baseAsset);
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.FILL_ORDER, { m: databasePair });
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.ORDER_HISTORY, { m: databasePair });
  if (currentAccount) {
    useDdpSubscription(DDP_CONFIG.PUBLICATIONS.FILL_ORDER, { m: databasePair, u: currentAccount });
    useDdpSubscription(DDP_CONFIG.PUBLICATIONS.ORDER_HISTORY, { u: currentAccount });
  }
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.BALANCE, { u: currentAccount });
  useDdpSubscription(DDP_CONFIG.PUBLICATIONS.PRICE);

  const prices = useCollection<PriceDoc>(DDP_CONFIG.COLLECTIONS.PRICE);
  const guidancePrice = useMemo(() => {
    const baseP = prices.find(p => p.a === baseAsset)?.p;
    const quoteP = prices.find(p => p.a === quoteAsset)?.p;
    if (baseP && quoteP && quoteP > 0) {
      return baseP / quoteP;
    }
    if (baseP && quoteAsset === 'CNY') return baseP;
    return null;
  }, [prices, baseAsset, quoteAsset]);

  const rawAsks = useCollection<OrderDoc>(
    DDP_CONFIG.COLLECTIONS.ORDER,
    o => o.a?.s === baseAsset && o.a?.b === quoteAsset,
    (a, b) => (a.p || 0) - (b.p || 0)
  );

  const rawBids = useCollection<OrderDoc>(
    DDP_CONFIG.COLLECTIONS.ORDER,
    o => o.a?.s === quoteAsset && o.a?.b === baseAsset,
    (a, b) => (1 / (b.p || 1)) - (1 / (a.p || 1))
  );

  const rawTrades = useCollection<FillOrderDoc>(
    DDP_CONFIG.COLLECTIONS.FILL_ORDER,
    tr => tr.m === databasePair,
    (a, b) => parseMongoTime(b.T) - parseMongoTime(a.T)
  );

  const processedTrades = rawTrades.map(tr => {
    const isInverse = tr.a && tr.a[0] !== baseAsset;
    const unifiedPrice = (isInverse && tr.p > 0) ? (1 / tr.p) : (tr.p || 0);
    const amount = tr.a && tr.a[0] === baseAsset ? (tr.b?.[0] || 0) : (tr.b?.[1] || tr.b?.[0] || 0);
    const isBuyerTaker = tr.t_side === 'buy' || (tr.a && tr.a[0] === quoteAsset);

    const takerUser = tr.u?.[0] || '--';
    const makerUser = tr.u?.[1] || '--';
    const isRelatedToMe = !!(currentAccount && (takerUser === currentAccount || makerUser === currentAccount));

    return {
      ...tr,
      displayPrice: unifiedPrice,
      displayAmount: amount,
      isBuyerTaker,
      takerUser,
      makerUser,
      isRelatedToMe,
      isTakerMe: currentAccount && takerUser === currentAccount,
      isMakerMe: currentAccount && makerUser === currentAccount
    };
  });

  // 🌟 核心改进：全网下单记录统一换算为当前页面的 quote/base，并识别买单/卖单
  const rawOrderHistory = useCollection<OrderHistoryDoc>(
    DDP_CONFIG.COLLECTIONS.ORDER_HISTORY,
    oh => oh.m === databasePair || oh.m === currentPair || (Array.isArray(oh.a) && oh.a.includes(baseAsset) && oh.a.includes(quoteAsset)),
    (a, b) => parseMongoTime(b.T) - parseMongoTime(a.T)
  );

  const processedOrderHistory = rawOrderHistory.map(oh => {
    // 判断买卖方向：在当前市场 baseAsset/quoteAsset 中：
    // 如果卖出的是 baseAsset，换得的是 quoteAsset，则是【卖单】；
    // 如果卖出的是 quoteAsset，换得的是 baseAsset，则是【买单】。
    let orderSide: 'buy' | 'sell' = 'buy';
    let unifiedPrice = oh.p || 0;

    if (Array.isArray(oh.a) && oh.a.length >= 2) {
      const sellAsset = oh.a[0];
      const buyAsset = oh.a[1];

      if (sellAsset === baseAsset && buyAsset === quoteAsset) {
        // 卖出 baseAsset，价格本身就是 Quote/Base
        orderSide = 'sell';
        unifiedPrice = oh.p || 0;
      } else if (sellAsset === quoteAsset && buyAsset === baseAsset) {
        // 卖出 quoteAsset 买入 baseAsset，属于买单
        // 原 p 为 Base/Quote，统一为当前市场的 Quote/Base 价格必须取倒数
        orderSide = 'buy';
        unifiedPrice = oh.p > 0 ? (1 / oh.p) : 0;
      } else {
        // 降级兜底
        orderSide = oh.p < 1 ? 'buy' : 'sell';
      }
    } else {
      orderSide = 'buy';
    }

    return {
      ...oh,
      orderSide,
      unifiedPrice
    };
  });

  const balances = useCollection<BalanceDoc>(DDP_CONFIG.COLLECTIONS.BALANCE, b => b.u === currentAccount);
  const baseBal = balances.find(b => b.a === baseAsset)?.f || 0;
  const quoteBal = balances.find(b => b.a === quoteAsset)?.f || 0;

  useEffect(() => {
    if (rawAsks.length > 0 && !buyPrice) {
      const bestAsk = rawAsks[0].p;
      if (bestAsk) setBuyPrice(formatSignificantPrice(bestAsk));
    }
    if (rawBids.length > 0 && !sellPrice) {
      const bestBid = rawBids[0].p ? (1 / rawBids[0].p) : 0;
      if (bestBid) setSellPrice(formatSignificantPrice(bestBid));
    }
  }, [rawAsks, rawBids]);

  useEffect(() => {
    const fetchSummary = async () => {
      try {
        const res = await ddpPool.call(DDP_CONFIG.METHODS.GET_MARKET_SUMMARY, databasePair);
        if (res) {
          if (databasePair !== currentPair && res.price) {
            setSummary({
              price: 1 / res.price,
              change: -res.change,
              high: res.low ? (1 / res.low) : 0,
              low: res.high ? (1 / res.high) : 0,
              volume: res.volume
            });
          } else {
            setSummary(res);
          }
        }
      } catch {}
    };
    fetchSummary();
  }, [databasePair, currentPair]);

  const handleSearchMarket = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = searchInput.trim().toUpperCase().replace('/', '_');
    if (clean.includes('_')) {
      setCurrentPair(clean);
      setSearchInput('');
    }
  };

  const handleMaxBuy = () => {
    const p = parseFloat(buyPrice);
    if (!p || p <= 0) {
      alert('请先输入有效的买入单价');
      return;
    }
    const maxCanBuy = quoteBal / p;
    setBuyAmount(maxCanBuy > 0 ? maxCanBuy.toFixed(4) : '0');
  };

  const handleMaxSell = () => {
    setSellAmount(baseBal.toString());
  };

  const handlePlaceOrder = async (action: 'buy' | 'sell') => {
    if (!isLoggedIn) {
      alert('请先登录交易账号');
      return;
    }
    const p = action === 'buy' ? Number(buyPrice) : Number(sellPrice);
    const b = action === 'buy' ? Number(buyAmount) : Number(sellAmount);

    if (isNaN(p) || p <= 0 || isNaN(b) || b <= 0) {
      alert('请输入有效的价格和数量');
      return;
    }

    setIsSubmitting(true);
    try {
      const envelope = await signerInstance.signTransactionIntent('limit_order_create', {
        sell_asset: action === 'buy' ? quoteAsset : baseAsset,
        amount: action === 'buy' ? b * p : b,
        receive_asset: action === 'buy' ? baseAsset : quoteAsset,
        price: action === 'buy' ? 1 / p : p,
        fill_or_kill: false
      });

      await ddpPool.call(DDP_CONFIG.METHODS.REQUEST_PROXY_SIGN, envelope);
      alert('🚀 限价委托已发送至代理');
      if (action === 'buy') setBuyAmount('');
      else setSellAmount('');
    } catch (err: any) {
      alert(`下单失败: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelOrder = async (orderDoc: any) => {
    const formattedOrderId = extractBitsharesOrderId(orderDoc);
    if (!formattedOrderId || !formattedOrderId.startsWith('1.7.')) {
      alert('无法解析该订单的有效 BitShares 链上 ID (1.7.X)');
      return;
    }

    if (!confirm(`确定撤销限价委托 ${formattedOrderId} 吗？`)) return;

    try {
      const envelope = await signerInstance.signTransactionIntent('limit_order_cancel', {
        order_id: formattedOrderId
      });
      await ddpPool.call(DDP_CONFIG.METHODS.REQUEST_PROXY_SIGN, envelope);
      alert(`撤单请求已发送: ${formattedOrderId}`);
    } catch (err: any) {
      alert(`撤单失败: ${err.message}`);
    }
  };

  const isCurrentFav = isFavorite('markets', currentPair);

  return (
    <div className="space-y-6 animate-fade-in pb-16 md:pb-0 text-sm">
      
      {/* 市场概览 */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-4 md:p-6 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl md:text-2xl font-black flex items-center gap-2">
            <span>📊 {baseAsset} / {quoteAsset}</span>
            <button
              onClick={() => toggleFavorite('markets', currentPair)}
              className={`text-xl cursor-pointer transition ${isCurrentFav ? 'text-amber-500' : 'text-gray-400'}`}
              title="收藏该交易对"
            >
              {isCurrentFav ? '★' : '☆'}
            </button>
          </h2>

          <select
            value={currentPair}
            onChange={(e) => setCurrentPair(e.target.value)}
            className="bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-2.5 py-1 text-xs font-bold font-mono outline-none"
          >
            {Array.from(new Set(['BTS_CNY', 'BTS_USD', ...favs.markets])).map(pair => (
              <option key={pair} value={pair}>
                {isFavorite('markets', pair) ? '★' : '•'} {pair.replace('_', ' / ')}
              </option>
            ))}
          </select>

          <form onSubmit={handleSearchMarket} className="flex items-center gap-1.5">
            <input
              type="text"
              placeholder={t.searchMarketPlaceholder}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl px-2.5 py-1 text-xs font-mono focus:outline-none focus:border-blue-500"
            />
            <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-3 py-1 rounded-xl text-xs cursor-pointer">
              Go
            </button>
          </form>
        </div>

        <div className="flex flex-wrap gap-4 text-xs font-mono">
          <div>
            <span className="text-gray-400 block">{t.lastPrice}</span>
            <b className="text-blue-500 text-sm md:text-base">{formatSignificantPrice(summary.price)}</b>
          </div>

          {guidancePrice !== null && (
            <div>
              <span className="text-gray-400 block">指导价</span>
              <b className="text-purple-500 text-sm md:text-base">{formatSignificantPrice(guidancePrice)}</b>
            </div>
          )}

          <div>
            <span className="text-gray-400 block">{t.change24h}</span>
            <b className={`text-xs md:text-sm ${summary.change >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {summary.change >= 0 ? '+' : ''}{summary.change?.toFixed(2)}%
            </b>
          </div>
          <div>
            <span className="text-gray-400 block">{t.high24h}</span>
            <b className="text-xs md:text-sm">{formatSignificantPrice(summary.high)}</b>
          </div>
          <div>
            <span className="text-gray-400 block">{t.low24h}</span>
            <b className="text-xs md:text-sm">{formatSignificantPrice(summary.low)}</b>
          </div>
        </div>
      </div>

      {/* 下单面板 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm space-y-3">
          <div className="flex justify-between items-center">
            <h4 className="text-sm font-bold text-emerald-500">🟢 {t.buyAsset} {baseAsset}</h4>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{t.balanceAvailable}: <b className="font-mono">{quoteBal.toFixed(2)}</b> {quoteAsset}</span>
              <button
                type="button"
                onClick={handleMaxBuy}
                className="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer"
              >
                100% 全仓
              </button>
            </div>
          </div>
          <input
            type="number"
            step="any"
            placeholder={`${t.price} (${quoteAsset})`}
            value={buyPrice}
            onChange={(e) => setBuyPrice(e.target.value)}
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-blue-500"
          />
          <input
            type="number"
            step="any"
            placeholder={`${t.quantity} (${baseAsset})`}
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => handlePlaceOrder('buy')}
            disabled={isSubmitting}
            className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 text-white font-bold py-3 rounded-2xl text-xs transition cursor-pointer"
          >
            {t.priceLimit} {t.buyAsset} {baseAsset}
          </button>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-5 shadow-sm space-y-3">
          <div className="flex justify-between items-center">
            <h4 className="text-sm font-bold text-red-500">🔴 {t.sellAsset} {baseAsset}</h4>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{t.balanceAvailable}: <b className="font-mono">{baseBal.toFixed(2)}</b> {baseAsset}</span>
              <button
                type="button"
                onClick={handleMaxSell}
                className="bg-red-500/10 hover:bg-red-500/20 text-red-500 px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer"
              >
                100% 全部
              </button>
            </div>
          </div>
          <input
            type="number"
            step="any"
            placeholder={`${t.price} (${quoteAsset})`}
            value={sellPrice}
            onChange={(e) => setSellPrice(e.target.value)}
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-blue-500"
          />
          <input
            type="number"
            step="any"
            placeholder={`${t.quantity} (${baseAsset})`}
            value={sellAmount}
            onChange={(e) => setSellAmount(e.target.value)}
            className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl px-3.5 py-2.5 text-sm font-mono focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => handlePlaceOrder('sell')}
            disabled={isSubmitting}
            className="w-full bg-red-600 hover:bg-red-700 disabled:bg-gray-700 text-white font-bold py-3 rounded-2xl text-xs transition cursor-pointer"
          >
            {t.priceLimit} {t.sellAsset} {baseAsset}
          </button>
        </div>
      </div>

      {/* 盘口与成交明细 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-stretch">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-4 shadow-sm flex flex-col h-full">
          <h4 className="text-xs font-bold text-emerald-500 mb-2 uppercase tracking-wider">{t.bidsBook} ({rawBids.length})</h4>
          
          <div className="flex justify-between text-[11px] text-gray-400 font-bold border-b border-gray-200 dark:border-gray-800 pb-1.5 mb-1.5">
            <span className="w-[40%]">{t.price} ({quoteAsset})</span>
            <span className="w-[35%] text-right">{t.quantity}</span>
            <span className="w-[25%] text-right">{t.trader}</span>
          </div>

          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1 flex-1 text-xs">
            {rawBids.map(o => {
              const isMine = currentAccount && o.u === currentAccount;
              const priceVal = o.p ? (1 / o.p) : 0;
              const amountVal = o.p ? (o.b * o.p) : 0;
              return (
                <div key={parseMongoId(o.id || o._id)} className="flex items-center justify-between py-0.5 font-mono">
                  <div className="w-[40%] flex items-center gap-1 overflow-hidden">
                    <span className="text-emerald-500 font-bold">{formatSignificantPrice(priceVal)}</span>
                    {isMine && (
                      <button
                        onClick={() => handleCancelOrder(o)}
                        className="bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer"
                        title="撤单"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <span className="w-[35%] text-right text-gray-800 dark:text-gray-200">{amountVal.toFixed(2)}</span>
                  <Link to={`/user/${o.u}`} className="w-[25%] text-right text-blue-500 hover:underline truncate text-[11px]" title={o.u}>
                    {o.u}
                  </Link>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-4 shadow-sm flex flex-col h-full">
          <h4 className="text-xs font-bold text-red-500 mb-2 uppercase tracking-wider">{t.asksBook} ({rawAsks.length})</h4>
          
          <div className="flex justify-between text-[11px] text-gray-400 font-bold border-b border-gray-200 dark:border-gray-800 pb-1.5 mb-1.5">
            <span className="w-[40%]">{t.price} ({quoteAsset})</span>
            <span className="w-[35%] text-right">{t.quantity}</span>
            <span className="w-[25%] text-right">{t.trader}</span>
          </div>

          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1 flex-1 text-xs">
            {rawAsks.map(o => {
              const isMine = currentAccount && o.u === currentAccount;
              return (
                <div key={parseMongoId(o.id || o._id)} className="flex items-center justify-between py-0.5 font-mono">
                  <div className="w-[40%] flex items-center gap-1 overflow-hidden">
                    <span className="text-red-500 font-bold">{formatSignificantPrice(o.p)}</span>
                    {isMine && (
                      <button
                        onClick={() => handleCancelOrder(o)}
                        className="bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white px-1 py-0.5 rounded text-[10px] font-bold cursor-pointer"
                        title="撤单"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <span className="w-[35%] text-right text-gray-800 dark:text-gray-200">{o.b?.toFixed(2)}</span>
                  <Link to={`/user/${o.u}`} className="w-[25%] text-right text-blue-500 hover:underline truncate text-[11px]" title={o.u}>
                    {o.u}
                  </Link>
                </div>
              );
            })}
          </div>
        </div>

        {/* 成交历史 */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-4 shadow-sm flex flex-col h-full">
          <h4 className="text-xs font-bold text-blue-500 mb-2 uppercase tracking-wider">{t.tradeHistory} ({processedTrades.length})</h4>
          
          <div className="flex justify-between text-[11px] text-gray-400 font-bold border-b border-gray-200 dark:border-gray-800 pb-1.5 mb-1.5">
            <span className="w-[32%]">{t.time}</span>
            <span className="w-[25%] text-right">{t.price}</span>
            <span className="w-[19%] text-right">{t.amount}</span>
            <span className="w-[24%] text-right">Taker / Maker</span>
          </div>

          <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1 flex-1 font-mono text-xs">
            {processedTrades.map(tr => {
              const dt = formatSmartDateTime(tr.T);

              return (
                <div 
                  key={parseMongoId(tr.id || tr._id)} 
                  className={`flex justify-between items-center py-1.5 px-2 rounded-xl border transition-all ${
                    tr.isRelatedToMe 
                      ? 'bg-blue-500/15 border-blue-500/40 shadow-xs' 
                      : 'border-gray-100 dark:border-gray-800/50 hover:bg-gray-50 dark:hover:bg-gray-800/30'
                  }`}
                >
                  <div className="w-[32%] flex flex-col" title={dt.fullStr}>
                    <span className="text-gray-800 dark:text-gray-200 text-[11px] leading-tight font-medium">{dt.dateStr}</span>
                    <span className="text-gray-400 text-[10px] leading-tight mt-0.5">{dt.timeStr}</span>
                  </div>

                  <span className={`w-[25%] text-right font-bold ${tr.isBuyerTaker ? 'text-emerald-500' : 'text-red-500'}`}>
                    {formatSignificantPrice(tr.displayPrice)}
                  </span>
                  
                  <span className="w-[19%] text-right text-gray-800 dark:text-gray-300">
                    {tr.displayAmount?.toFixed(2)}
                  </span>

                  <div className="w-[24%] flex flex-col items-end text-[10px] truncate leading-tight">
                    <div className="flex items-center gap-0.5 truncate max-w-full">
                      <span className="text-gray-400 text-[9px] shrink-0">T:</span>
                      <Link
                        to={`/user/${tr.takerUser}`}
                        className={`truncate hover:underline ${tr.isTakerMe ? 'text-amber-500 font-extrabold' : 'text-blue-500'}`}
                        title={`Taker: ${tr.takerUser}`}
                      >
                        {tr.takerUser}
                      </Link>
                    </div>

                    <div className="flex items-center gap-0.5 truncate max-w-full mt-0.5">
                      <span className="text-gray-400 text-[9px] shrink-0">M:</span>
                      <Link
                        to={`/user/${tr.makerUser}`}
                        className={`truncate hover:underline ${tr.isMakerMe ? 'text-amber-500 font-extrabold' : 'text-gray-400'}`}
                        title={`Maker: ${tr.makerUser}`}
                      >
                        {tr.makerUser}
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 🌟 核心改进：全网下单记录价格统一到当前市场的 Quote/Base，颜色区分买单(绿)/卖单(红) */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-3xl p-4 md:p-5 shadow-sm">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-xs font-bold text-amber-500 uppercase tracking-wider">
            📋 市场全网下单流水 ({processedOrderHistory.length})
          </h3>
          <span className="text-[11px] text-gray-400 font-mono">统一计价: 1 {baseAsset} = X {quoteAsset}</span>
        </div>

        <div className="grid grid-cols-12 text-[11px] text-gray-400 font-bold border-b border-gray-200 dark:border-gray-800 pb-1.5 mb-1.5">
          <span className="col-span-4 sm:col-span-3">{t.time}</span>
          <span className="col-span-3 sm:col-span-3">用户</span>
          <span className="col-span-2 sm:col-span-2">{t.action}</span>
          <span className="col-span-3 sm:col-span-4 text-right">价格 ({quoteAsset})</span>
        </div>

        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1 font-mono text-xs">
          {processedOrderHistory.length === 0 ? (
            <p className="text-xs text-gray-400 py-4 text-center">{t.noData}</p>
          ) : (
            processedOrderHistory.map(oh => {
              const dt = formatSmartDateTime(oh.T);
              const isMine = currentAccount && oh.u === currentAccount;
              const isBuyOrder = oh.orderSide === 'buy';

              return (
                <div 
                  key={parseMongoId(oh._id)} 
                  className={`grid grid-cols-12 py-1.5 px-2 rounded-xl items-center border transition-all ${
                    isMine 
                      ? 'bg-amber-500/10 border-amber-500/30 shadow-xs' 
                      : 'border-gray-100 dark:border-gray-800/40 hover:bg-gray-50 dark:hover:bg-gray-800/20'
                  }`}
                >
                  <div className="col-span-4 sm:col-span-3 flex flex-col" title={dt.fullStr}>
                    <span className="text-gray-800 dark:text-gray-200 text-[11px] leading-tight font-medium">{dt.dateStr}</span>
                    <span className="text-gray-400 text-[10px] leading-tight mt-0.5">{dt.timeStr}</span>
                  </div>

                  <div className="col-span-3 sm:col-span-3 truncate">
                    <Link 
                      to={`/user/${oh.u}`} 
                      className={`truncate hover:underline ${isMine ? 'text-amber-500 font-black' : 'text-blue-500'}`}
                      title={oh.u}
                    >
                      {oh.u}
                    </Link>
                  </div>

                  <div className="col-span-2 sm:col-span-2 flex items-center gap-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-extrabold ${
                      oh.t === 1 
                        ? 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30' 
                        : (oh.t === 2 
                            ? 'bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30' 
                            : 'bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30')
                    }`}>
                      {oh.t === 1 ? t.placeOrder : (oh.t === 77 ? t.updateOrder : t.cancelOrder)}
                    </span>
                    <span className={`text-[9px] font-bold px-1 rounded ${isBuyOrder ? 'text-emerald-500 bg-emerald-500/10' : 'text-red-500 bg-red-500/10'}`}>
                      {isBuyOrder ? '买' : '卖'}
                    </span>
                  </div>

                  {/* 🌟 价格按买单(绿色) / 卖单(红色) 高亮区分，数值统一到当前页面的 quote/base 计价 */}
                  <span className={`col-span-3 sm:col-span-4 text-right font-black ${isBuyOrder ? 'text-emerald-500' : 'text-red-500'}`}>
                    {formatSignificantPrice(oh.unifiedPrice)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

    </div>
  );
};