'use strict';
// ═══════════════════════════════════════════════════
//  BetXBee Virtual Esports Engine v3.0
//
//  BETTING MARKETS (per match):
//  1. Match Winner     — Team A / Team B
//  2. Total Kills O/U  — Over X.5 / Under X.5
//  3. Kill Handicap    — Fav -X.5 / Dog +X.5
//  4. Winning Margin   — 1-3 / 4-7 / 8+ kills
//  5. First Blood      — Team A first kill / Team B
//  6. Both Teams 10+   — Yes / No (both score ≥10)
//
//  All markets: correct bookmaker odds (sum of 1/odds > 1)
//  Live markets: odds update dynamically with scores
//  Settlement: deterministic, checked against final scores
// ═══════════════════════════════════════════════════

const Engine = (() => {

  /* ── CONSTANTS ─────────────────────────────────── */
  const MATCH_MS   = 20 * 60 * 1000;
  const MAX_LIVE   = 30;
  const OVERROUND  = 1.09;  // 9% bookmaker margin

  /* ── TEAM DATA ──────────────────────────────────── */
  const ADJ = ['Shadow','Neon','Cyber','Vortex','Inferno','Storm','Frost','Phantom',
    'Apex','Blaze','Nova','Titan','Pulse','Void','Steel','Chaos','Echo','Dark','Iron',
    'Ghost','Hyper','Solar','Lunar','Atomic','Surge','Prism','Delta','Omega','Alpha',
    'Ultra','Savage','Divine','Eternal','Silent','Rogue','Crimson','Azure','Jade','Onyx','Ember'];
  const NOUN = ['Squad','Force','Legion','Wolves','Dragons','Hawks','Vipers','Reapers',
    'Clan','Guild','Pack','Empire','Order','Corps','Alliance','Division','Syndicate',
    'Cartel','Outlaws','Hunters','Warriors','Knights','Lords','Phantoms','Wraiths',
    'Titans','Sentinels','Gladiators','Predators','Ghosts'];
  const GAME_TYPES = ['FPS','MOBA','Battle Royale','RTS','Fighting'];
  const GAME_MAP = {
    FPS:           { icon:'🎯', games:['NightStrike','TacForce','ValoX','ShadowOps','BlastZone'] },
    MOBA:          { icon:'⚔️', games:['ArenaLords','MythBattle','HeroClash','RuneWar','TowerFall'] },
    'Battle Royale':{ icon:'💀', games:['LastZone','StormRing','DropZone','CircleWar','ApexDrop'] },
    RTS:           { icon:'🏰', games:['CommandX','StratBase','WarlordRTS','BattleMap','TechWar'] },
    Fighting:      { icon:'🥊', games:['FistFury','KombatX','ArenaFight','BrawlMaster','PunchOut'] }
  };
  const EMOJIS = ['🐺','🦅','🐉','🐍','🦁','🐯','🦊','🐻','🦈','🦂','🦉','🦏','🐊','🐘','🦬',
    '🦌','🐗','🦎','🦑','🐙','🦋','🕷','🐞','🦕','🦖','🐲','🦢','🦩','🦚','🦜',
    '🦝','🦨','🦦','🦥','🐿','🦔','🦠','🧿','🐬','🦤'];
  const COLORS = ['#ff4444','#ff8800','#ffcc00','#44ff88','#00ccff','#8844ff','#ff44cc','#ff6644',
    '#44ffcc','#ff88ff','#88ff44','#44aaff','#ff4488','#ffaa00','#00ffaa','#aa00ff',
    '#ff0088','#00ff44','#0088ff','#ff6600'];
  const REGIONS = ['NA','EU','APAC','SA','ME','OCE'];

  /* ── TEAMS ──────────────────────────────────────── */
  function generateTeams() {
    const teams = [];
    for (let i = 0; i < 100; i++) {
      const adj  = ADJ[i % ADJ.length];
      const noun = NOUN[Math.floor(i / ADJ.length) % NOUN.length];
      const sfx  = i >= ADJ.length * NOUN.length ? ` ${Math.floor(i/ADJ.length)+1}` : '';
      let str;
      if      (i < 10) str = 82 + (i%5)*2.4;
      else if (i < 30) str = 64 + (i%10)*1.9;
      else if (i < 60) str = 44 + (i%15)*1.4;
      else             str = 25 + (i%20)*1.0;
      const tier = i<10?'Elite':i<30?'Pro':i<60?'Semi-Pro':'Amateur';
      teams.push({
        id:i, name:`${adj} ${noun}${sfx}`,
        short:(adj.slice(0,3)+noun.slice(0,2)).toUpperCase(),
        emoji:EMOJIS[i%EMOJIS.length], color:COLORS[i%COLORS.length],
        gameType:GAME_TYPES[i%GAME_TYPES.length], region:REGIONS[i%REGIONS.length],
        strength:Math.round(str), tier,
        wins:Math.floor(str*0.9+i%8), losses:Math.floor((100-str)*0.5+i%6)
      });
    }
    return teams;
  }

  /* ── CORE ODDS (correct bookmaker formula) ─────────
   *  odds = 1 / (prob × OVERROUND)
   *  Guarantees: sum(1/odds) = OVERROUND > 1  ✅
   *  Equal teams → 1.83 each, not 2.12
   * ─────────────────────────────────────────────── */
  function o(prob) {
    return Math.max(1.03, parseFloat((1 / (Math.min(0.97, Math.max(0.03, prob)) * OVERROUND)).toFixed(2)));
  }

  /* ── BUILD ALL MARKETS FOR A MATCH ────────────────
   *
   *  Returns an object with ALL 6 markets.
   *  Each market has: { id, name, options: [{key, label, odds}] }
   *  Plus match-level metadata stored on the match object:
   *    ouLine, handicapFav, handicapLine, firstBlood
   *
   * ─────────────────────────────────────────────── */
  function buildMarkets(tA, tB, matchId) {
    const sA = tA.strength, sB = tB.strength;
    const tot = sA + sB;
    const pA  = sA / tot;   // probability A wins
    const pB  = 1 - pA;

    // ── 1. Match Winner ──────────────────────────
    const mkt1 = {
      id:'winner', name:'Match Winner', icon:'🏆',
      opts:[
        { key:'winner_A', label:`${tA.name} Win`, shortLabel:`${tA.short} Win`, odds: o(pA) },
        { key:'winner_B', label:`${tB.name} Win`, shortLabel:`${tB.short} Win`, odds: o(pB) }
      ]
    };

    // ── 2. Total Kills Over/Under ─────────────────
    // Line scales with avg strength: elite teams score more
    const avgStr  = (sA + sB) / 2;
    const ouLine  = avgStr > 68 ? 33.5 : avgStr > 52 ? 31.5 : 29.5;
    // Over prob = higher strength → more kills → more likely over
    const pOver   = 0.42 + (avgStr - 50) * 0.003;   // ~38-56%
    const mkt2 = {
      id:'ou', name:`Total Kills`, icon:'📊',
      line: ouLine,
      opts:[
        { key:'ou_over',  label:`Over ${ouLine}`,  shortLabel:`O ${ouLine}`,  odds: o(Math.min(0.7, pOver)) },
        { key:'ou_under', label:`Under ${ouLine}`, shortLabel:`U ${ouLine}`, odds: o(Math.min(0.7, 1-pOver)) }
      ]
    };

    // ── 3. Kill Handicap ─────────────────────────
    // Stronger team gives away kills (-line), weaker gets them (+line)
    const strDiff = Math.abs(sA - sB);
    const hLine   = strDiff < 8 ? 2.5 : strDiff < 20 ? 4.5 : strDiff < 35 ? 6.5 : 9.5;
    const hFav    = sA >= sB ? 'A' : 'B';
    const hFavTeam = hFav === 'A' ? tA : tB;
    const hDogTeam = hFav === 'A' ? tB : tA;
    // With line set proportionally, each side ~47-53%
    const pHFav   = 0.45 + (strDiff / 400);   // 45-57%
    const mkt3 = {
      id:'handicap', name:'Kill Handicap', icon:'⚖️',
      line: hLine, favSide: hFav,
      opts:[
        { key:'handicap_fav', label:`${hFavTeam.short} -${hLine}`, shortLabel:`${hFavTeam.short} -${hLine}`, odds: o(Math.min(0.65, pHFav)) },
        { key:'handicap_dog', label:`${hDogTeam.short} +${hLine}`, shortLabel:`${hDogTeam.short} +${hLine}`, odds: o(1 - Math.min(0.65, pHFav)) }
      ]
    };

    // ── 4. Winning Margin ─────────────────────────
    // 3-way: 1-3 kills / 4-7 kills / 8+ kills
    // Close teams → more close finishes; mismatched → big margins
    const pClose = Math.max(0.10, 0.38 - strDiff * 0.004); // 1-3
    const pBig   = Math.max(0.10, 0.22 + strDiff * 0.004); // 8+
    const pMid   = Math.max(0.10, 1 - pClose - pBig);       // 4-7
    const mkt4 = {
      id:'margin', name:'Winning Margin', icon:'📏',
      opts:[
        { key:'margin_1_3', label:'Win by 1–3',  shortLabel:'1–3 Kills',  odds: o(pClose) },
        { key:'margin_4_7', label:'Win by 4–7',  shortLabel:'4–7 Kills',  odds: o(pMid)   },
        { key:'margin_8p',  label:'Win by 8+',   shortLabel:'8+ Kills',   odds: o(pBig)   }
      ]
    };

    // ── 5. First Blood ────────────────────────────
    // Probability = same as winner but steeper (first kill ≈ early aggression)
    const pFBA = 0.35 + pA * 0.3;  // maps pA(0-1) → pFBA(0.35-0.65)
    // First blood is pre-determined at match creation
    const fbWinner = seeded(matchId * 53 + tA.id) < pFBA ? 'A' : 'B';
    const mkt5 = {
      id:'firstblood', name:'First Blood', icon:'🩸',
      firstBlood: fbWinner,
      opts:[
        { key:'fb_A', label:`${tA.name} First Kill`, shortLabel:`${tA.short} First`, odds: o(pFBA) },
        { key:'fb_B', label:`${tB.name} First Kill`, shortLabel:`${tB.short} First`, odds: o(1-pFBA) }
      ]
    };

    // ── 6. Both Teams 10+ Kills ───────────────────
    // Higher strength = both teams more active = more likely both hit 10+
    const pBTTS = Math.min(0.82, 0.32 + avgStr * 0.006);   // ~47-82%
    const mkt6 = {
      id:'btts', name:'Both Teams 10+ Kills', icon:'💥',
      opts:[
        { key:'btts_yes', label:'Both Teams 10+', shortLabel:'Both 10+', odds: o(pBTTS) },
        { key:'btts_no',  label:'Not Both 10+',   shortLabel:'Not Both', odds: o(1-pBTTS) }
      ]
    };

    return {
      markets: [mkt1, mkt2, mkt3, mkt4, mkt5, mkt6],
      // Stored on match for settlement
      ouLine, handicapFav: hFav, handicapLine: hLine, firstBlood: fbWinner
    };
  }

  /* ── LIVE ODDS UPDATE (markets 1, 2, 3 shift live) ─
   *
   *  As match progresses:
   *  - Winner market: score-weighted probability
   *  - O/U: recalculate from running total
   *  - Handicap: follow score gap vs line
   *  Markets 4, 5, 6: recalculate from projected final
   *
   * ─────────────────────────────────────────────── */
  function updateLiveMarkets(match) {
    const { teamA, teamB, scoreA, scoreB, pct,
            ouLine, handicapFav, handicapLine, firstBlood } = match;
    const sA = teamA.strength, sB = teamB.strength;
    const timeW = Math.min(1, pct / 100);

    // Score-adjusted strength for winner odds
    const scoreDiff  = scoreA - scoreB;
    const shift      = Math.tanh(scoreDiff / 5) * 28 * timeW;
    const adjA       = Math.max(5, sA + shift);
    const adjB       = Math.max(5, sB - shift);
    const liveTotal  = adjA + adjB;
    const liveProbA  = adjA / liveTotal;

    // Project final total kills (linear extrapolation)
    const currentTotal  = scoreA + scoreB;
    const projTotal     = pct > 3 ? (currentTotal / pct) * 100 : currentTotal + 30;
    const projDiff      = pct > 3 ? Math.abs(scoreDiff) / pct * 100 : Math.abs(sA-sB)/sA*6;

    // ── 1. Winner (live) ──
    match.markets[0].opts[0].odds = o(liveProbA);
    match.markets[0].opts[1].odds = o(1 - liveProbA);
    match.markets[0].opts[0].dir = _dir(match._prevOddsW_A, match.markets[0].opts[0].odds);
    match.markets[0].opts[1].dir = _dir(match._prevOddsW_B, match.markets[0].opts[1].odds);
    match._prevOddsW_A = match.markets[0].opts[0].odds;
    match._prevOddsW_B = match.markets[0].opts[1].odds;

    // ── 2. O/U (live) ──
    const pOver = 1 / (1 + Math.exp(-(projTotal - ouLine) * 0.4));  // sigmoid
    match.markets[1].opts[0].odds = o(Math.min(0.85, Math.max(0.1, pOver)));
    match.markets[1].opts[1].odds = o(Math.min(0.85, Math.max(0.1, 1 - pOver)));
    match.markets[1].opts[0].dir = _dir(match._prevOddsOU_O, match.markets[1].opts[0].odds);
    match.markets[1].opts[1].dir = _dir(match._prevOddsOU_U, match.markets[1].opts[1].odds);
    match._prevOddsOU_O = match.markets[1].opts[0].odds;
    match._prevOddsOU_U = match.markets[1].opts[1].odds;

    // ── 3. Handicap (live) ──
    const currentGap     = handicapFav==='A' ? scoreDiff : -scoreDiff;
    const pHandicapFav   = 1 / (1 + Math.exp(-(currentGap - handicapLine) * 0.5 * timeW + (1 - timeW) * 0));
    const clampedPHF     = Math.min(0.85, Math.max(0.1, pHandicapFav));
    match.markets[2].opts[0].odds = o(clampedPHF);
    match.markets[2].opts[1].odds = o(1 - clampedPHF);
    match.markets[2].opts[0].dir = _dir(match._prevOddsHF, match.markets[2].opts[0].odds);
    match.markets[2].opts[1].dir = _dir(match._prevOddsHD, match.markets[2].opts[1].odds);
    match._prevOddsHF = match.markets[2].opts[0].odds;
    match._prevOddsHD = match.markets[2].opts[1].odds;

    // ── 4. Margin (live) — projected diff ──
    const pC = Math.max(0.05, 0.38 - projDiff * 0.025);
    const pB = Math.max(0.05, 0.22 + projDiff * 0.025);
    const pM = Math.max(0.05, 1 - pC - pB);
    match.markets[3].opts[0].odds = o(pC);
    match.markets[3].opts[1].odds = o(pM);
    match.markets[3].opts[2].odds = o(pB);

    // ── 5. First Blood — stays fixed after early game ──
    // Once 5% elapsed, first blood is locked; odds go to near-certain
    if (pct >= 5) {
      match.markets[4].opts[0].odds = firstBlood==='A' ? 1.03 : 24.0;
      match.markets[4].opts[1].odds = firstBlood==='B' ? 1.03 : 24.0;
    }

    // ── 6. BTTS — both teams running score ──
    const aBigEnough = scoreA >= 10;
    const bBigEnough = scoreB >= 10;
    if (pct > 50) {
      // If both already at 10+: YES almost certain
      // If one team at 0-5 and already 70%+ done: NO likely
      const pYes = aBigEnough && bBigEnough ? 0.92
        : (!aBigEnough && pct > 70) ? 0.08
        : (!bBigEnough && pct > 70) ? 0.08
        : match.markets[5].opts[0].odds > 0 ? (1/(match.markets[5].opts[0].odds * OVERROUND)) : 0.5;
      match.markets[5].opts[0].odds = o(Math.min(0.95, Math.max(0.04, pYes)));
      match.markets[5].opts[1].odds = o(Math.min(0.95, Math.max(0.04, 1 - pYes)));
    }
  }

  function _dir(prev, curr) {
    if (!prev) return 'same';
    if (curr < prev - 0.01) return 'down';
    if (curr > prev + 0.01) return 'up';
    return 'same';
  }

  /* ── SETTLEMENT — all 6 markets ──────────────────
   *
   *  Called when match.status === 'finished'
   *  sel = { key, odds }  (stored on bet at placement)
   *  Returns: true (won) | false (lost) | null (void/push)
   *
   * ─────────────────────────────────────────────── */
  function settleSelection(selKey, match) {
    const { scoreA, scoreB, winner, ouLine, handicapFav, handicapLine, firstBlood } = match;
    const total = scoreA + scoreB;
    const diff  = Math.abs(scoreA - scoreB);

    switch (selKey) {
      // ── Winner ──
      case 'winner_A': return winner === 'A';
      case 'winner_B': return winner === 'B';

      // ── Over/Under ── (exact = push/void → return null)
      case 'ou_over':
        if (total === ouLine) return null;   // push
        return total > ouLine;
      case 'ou_under':
        if (total === ouLine) return null;
        return total < ouLine;

      // ── Handicap ──
      case 'handicap_fav':
        // Fav must WIN and by MORE than line
        if (diff === handicapLine) return null; // push
        return winner === handicapFav && diff > handicapLine;
      case 'handicap_dog': {
        const dog = handicapFav === 'A' ? 'B' : 'A';
        if (diff === handicapLine) return null;
        return winner === dog || diff < handicapLine;
      }

      // ── Winning Margin ──
      case 'margin_1_3': return diff >= 1 && diff <= 3;
      case 'margin_4_7': return diff >= 4 && diff <= 7;
      case 'margin_8p':  return diff >= 8;

      // ── First Blood ──
      case 'fb_A': return firstBlood === 'A';
      case 'fb_B': return firstBlood === 'B';

      // ── BTTS ──
      case 'btts_yes': return scoreA >= 10 && scoreB >= 10;
      case 'btts_no':  return scoreA < 10 || scoreB < 10;

      default: return false;
    }
  }

  /* ── SEEDED RANDOM ──────────────────────────────── */
  function seeded(n) {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  function pickWinner(matchId, tA, tB) {
    return seeded(matchId * 31 + tA.id) < (tA.strength / (tA.strength + tB.strength)) ? 'A' : 'B';
  }

  /* ── LIVE SCORE ──────────────────────────────────── */
  function liveScore(match) {
    const now  = Date.now();
    const elap = Math.max(0, now - match.startTime);
    const pct  = Math.min(100, (elap / MATCH_MS) * 100);
    const frame = Math.floor(elap / 15000);
    const rA = match.teamA.strength, rB = match.teamB.strength;
    const ratio = rA / (rA + rB);
    const maxK  = 28;
    const base  = Math.floor(pct * 0.01 * maxK);
    const spread = Math.sqrt(pct / 100) * 3.5;
    let sA = Math.round(base * ratio       + (seeded(match.id*7  + frame) - 0.5) * spread);
    let sB = Math.round(base * (1 - ratio) + (seeded(match.id*13 + frame+1) - 0.5) * spread);
    sA = Math.max(0, sA); sB = Math.max(0, sB);
    if (pct >= 78) {
      const push = Math.ceil((pct - 78) / 7);
      if (match.winner === 'A' && sA <= sB) sA = sB + push;
      if (match.winner === 'B' && sB <= sA) sB = sA + push;
    }
    return { sA, sB, pct };
  }

  /* ── SCHEDULER ───────────────────────────────────── */
  class Scheduler {
    constructor(teams) {
      this.teams = teams; this.active = new Map();
      this.finished = []; this._busy = new Set(); this._nextId = 1; this._ready = false;
    }
    _avail()  { return this.teams.filter(t => !this._busy.has(t.id)); }
    _shuffle(a) { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];} return b; }

    _buildMatch(tA, tB, overrides={}) {
      const id = this._nextId++;
      const gt = GAME_TYPES[Math.floor(Math.random()*GAME_TYPES.length)];
      const gd = GAME_MAP[gt];
      const gn = gd.games[Math.floor(Math.random()*gd.games.length)];
      const mktData = buildMarkets(tA, tB, id);
      const now = Date.now();
      const m = {
        id, teamA:tA, teamB:tB,
        gameType:gt, gameIcon:gd.icon, gameName:gn,
        // Keep legacy top-level odds for match card display
        oddsA: mktData.markets[0].opts[0].odds,
        oddsB: mktData.markets[0].opts[1].odds,
        probA: tA.strength/(tA.strength+tB.strength),
        markets: mktData.markets,
        ouLine:        mktData.ouLine,
        handicapFav:   mktData.handicapFav,
        handicapLine:  mktData.handicapLine,
        firstBlood:    mktData.firstBlood,
        status:'countdown',
        startTime: overrides.startTime || now,
        endTime:   overrides.endTime   || now+MATCH_MS,
        winner: pickWinner(id, tA, tB),
        scoreA:0, scoreB:0, pct:0,
        events:[], viewers:Math.floor(5000+Math.random()*45000), createdAt:now,
        oddsDirA:'same', oddsDirB:'same'
      };
      if (overrides.status) m.status = overrides.status;
      this.active.set(id, m); this._busy.add(tA.id); this._busy.add(tB.id);
      return m;
    }

    initialize() {
      if (this._ready) return; this._ready = true;
      const levels = []; for(let i=0;i<25;i++) levels.push(3+(i/24)*92);
      this._shuffle(levels);
      for(let i=0;i<25;i++) {
        const pool = this._avail(); if(pool.length<2) break;
        const [tA,tB] = this._shuffle(pool);
        const pct     = levels[i];
        const elapsed = MATCH_MS * pct / 100;
        const now     = Date.now();
        const m = this._buildMatch(tA, tB, { status:'live', startTime:now-elapsed, endTime:now-elapsed+MATCH_MS });
        m.pct = pct;
        const s = liveScore(m); m.scoreA=s.sA; m.scoreB=s.sB;
        updateLiveMarkets(m);
      }
      const cds = [20,45,70,95,120];
      for(let i=0;i<5;i++) {
        const pool = this._avail(); if(pool.length<2) break;
        const [tA,tB] = this._shuffle(pool);
        const now = Date.now();
        this._buildMatch(tA, tB, { status:'countdown', startTime:now+cds[i]*1000, endTime:now+cds[i]*1000+MATCH_MS });
      }
    }

    _finishMatch(m) {
      m.status='finished';
      const base=18+Math.floor(Math.random()*10), gap=2+Math.floor(Math.random()*6);
      m.scoreA = m.winner==='A' ? base : Math.max(0,base-gap);
      m.scoreB = m.winner==='B' ? base : Math.max(0,base-gap);
      // Lock all market odds to final state
      updateLiveMarkets(m);
      this._busy.delete(m.teamA.id); this._busy.delete(m.teamB.id);
      this.active.delete(m.id); this.finished.unshift(m);
      if(this.finished.length>40) this.finished.length=40;
    }

    tick() {
      const now=Date.now(), changes=[];
      this.active.forEach(m=>{
        if(m.status==='countdown' && now>=m.startTime) { m.status='live'; changes.push({type:'started',match:m}); }
        if(m.status==='live') {
          const {sA,sB,pct}=liveScore(m);
          m.scoreA=sA; m.scoreB=sB; m.pct=pct;
          // Update top-level odds for card display (market 0)
          const prevA=m.oddsA, prevB=m.oddsB;
          updateLiveMarkets(m);
          m.oddsA=m.markets[0].opts[0].odds; m.oddsB=m.markets[0].opts[1].odds;
          m.oddsDirA = m.oddsA<prevA-0.01?'down':m.oddsA>prevA+0.01?'up':'same';
          m.oddsDirB = m.oddsB<prevB-0.01?'down':m.oddsB>prevB+0.01?'up':'same';
          if(Math.random()<0.018){ const ev=this._event(m); m.events.unshift(ev); if(m.events.length>8)m.events.length=8; changes.push({type:'event',match:m,ev}); }
          if(now>=m.endTime){ this._finishMatch(m); changes.push({type:'finished',match:m}); }
        }
      });
      const needed=MAX_LIVE-this.active.size;
      for(let i=0;i<needed;i++){
        const pool=this._avail(); if(pool.length<2) break;
        const [tA,tB]=this._shuffle(pool);
        const cd=(90+Math.floor(Math.random()*65))*1000, now2=Date.now();
        const m=this._buildMatch(tA,tB,{status:'countdown',startTime:now2+cd,endTime:now2+cd+MATCH_MS});
        changes.push({type:'created',match:m});
      }
      return changes;
    }

    _event(match) {
      const kinds=[
        {icon:'💥',texts:['ELIMINATION','DOUBLE KILL','TRIPLE KILL']},
        {icon:'🎯',texts:['HEADSHOT','PRECISION SHOT','SNIPER ACE']},
        {icon:'🔥',texts:['KILLING SPREE','ON FIRE','RAMPAGE']},
        {icon:'⚡',texts:['OBJECTIVE CAPTURED','POINT SECURED','ZONE TAKEN']},
        {icon:'👑',texts:['TEAM ACE','FLAWLESS ROUND','CLEAN SWEEP']},
        {icon:'🛡',texts:['DEFENSE HOLD','RETAKE SUCCESS','CLUTCH SAVE']},
        {icon:'🗡',texts:['AMBUSH','FLANK ATTACK','BACKDOOR']},
        {icon:'💣',texts:['BOMB PLANTED','DEFUSE FAILED','SITE CONTROL']},
      ];
      const isA=Math.random()<match.probA, team=isA?match.teamA:match.teamB;
      const k=kinds[Math.floor(Math.random()*kinds.length)];
      return {icon:k.icon, team:team.short, color:team.color, text:k.texts[Math.floor(Math.random()*k.texts.length)], min:Math.floor((match.pct||0)*0.2)};
    }

    getLive()      { return [...this.active.values()].filter(m=>m.status==='live').sort((a,b)=>a.endTime-b.endTime); }
    getCountdown() { return [...this.active.values()].filter(m=>m.status==='countdown').sort((a,b)=>a.startTime-b.startTime); }
    getFinished()  { return this.finished; }
    getAll()       { return [...this.getLive(),...this.getCountdown(),...this.getFinished()]; }
    getById(id)    { return this.active.get(id)||this.finished.find(m=>m.id===id)||null; }
  }

  /* ── FULL BET SETTLEMENT ─────────────────────────
   *  Handles all 6 markets including push (null)
   * ─────────────────────────────────────────────── */
  function settleBet(bet, finishedMatches) {
    // Each selection: { matchId, selKey, odds }
    // A bet is settled only when ALL its matches are finished
    const allFinished = bet.selections.every(s => {
      const m = finishedMatches.find(fm => fm.id === s.matchId);
      return m && m.status === 'finished';
    });
    if (!allFinished) return null;  // not ready yet

    let combinedOdds = 1;
    let hasVoid = false;
    for (const s of bet.selections) {
      const m = finishedMatches.find(fm => fm.id === s.matchId);
      const result = settleSelection(s.selKey, m);
      if (result === null) { hasVoid = true; continue; } // push — remove leg
      if (result === false) {
        return { ...bet, settled:true, won:false, payout:0, profit:-bet.stake };
      }
      combinedOdds *= s.odds;
    }
    if (hasVoid && combinedOdds === 1) {
      // All legs voided — return stake
      return { ...bet, settled:true, won:null, payout:bet.stake, profit:0, voided:true };
    }
    const payout = +(bet.stake * combinedOdds).toFixed(2);
    return { ...bet, settled:true, won:true, payout, profit:+(payout - bet.stake).toFixed(2) };
  }

  function fmtTime(ms) {
    if(ms<=0)return'00:00';
    const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  return { MATCH_MS, MAX_LIVE, OVERROUND, GAME_MAP, GAME_TYPES,
           generateTeams, buildMarkets, updateLiveMarkets, settleSelection, settleBet,
           Scheduler, fmtTime };
})();
