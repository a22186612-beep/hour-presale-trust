// 瀏覽器端到端測試：本機 ganache + 模擬 MetaMask，依序扮演經紀人老六、顧問 Dragon、客戶乾爹
const { chromium } = require('playwright'); const { ethers } = require('ethers'); const art = require('./artifacts.json');
const RPC = 'http://127.0.0.1:8545', OUT = process.argv[2];
(async () => {
  const p = new ethers.JsonRpcProvider(RPC); const accts = await p.send('eth_accounts', []);
  const [agency, dragon, phoenix, buyer] = accts; const dep = await p.getSigner(agency);
  const F = async (n, ...a) => { const c = await new ethers.ContractFactory(art[n].abi, art[n].bytecode, dep).deploy(...a); await c.waitForDeployment(); return c.target };
  const usdc = await F('MockUSDC');
  const hD = await F('HourToken', 'Dragon Hour', 'dHOUR', agency, dragon, 'Dragon', 480n);
  const hP = await F('HourToken', 'Phoenix Hour', 'pHOUR', agency, phoenix, 'Phoenix', 480n);
  const tD = await F('HourTrust', hD, usdc, 'Dragon', 25n, 15n, 12n, 4n, 70_000000n, 120n);
  const tP = await F('HourTrust', hP, usdc, 'Phoenix', 25n, 15n, 12n, 4n, 70_000000n, 120n);
  const cfg = { chainId: 11155111, usdc, consultants: [{ hour: hD, trust: tD, title: '調酒顧問', photo: 'img/dragon-pour.jpg' }, { hour: hP, trust: tP, title: '調香顧問', photo: 'img/phoenix-portrait.jpg' }],
    people: { [agency]: '老六', [dragon]: 'Dragon', [phoenix]: 'Phoenix', [buyer]: '乾爹' }, agencyName: '老六', explorer: 'https://sepolia.etherscan.io' };
  const b = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } } : {}); const errs = [];
  const open = async (acct, name) => {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 }, ignoreHTTPSErrors: true, timezoneId: 'Asia/Taipei' });
    
    await ctx.addInitScript(([cfg, acct, RPC]) => {
      window.APP_CONFIG = cfg; let id = 1;
      window.ethereum = { isMetaMask: true, on() { }, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct];
        if (method === 'eth_chainId') return '0xaa36a7';
        if (method === 'wallet_switchEthereumChain') return null;
        const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params: params || [] }) }); const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e } return j.result } };
    }, [cfg, acct, RPC]);
    const pg = await ctx.newPage(); pg.on('pageerror', e => errs.push(name + ': ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(name + ' console: ' + m.text()) });
    await pg.goto('http://127.0.0.1:8000/index.html'); await pg.waitForTimeout(2000); return pg
  };
  const click = async (pg, sel) => { await pg.evaluate(() => { document.getElementById('toast').innerHTML = '' }); await pg.click(sel); await pg.waitForSelector('#toast .toast.ok, #toast .toast.err', { timeout: 30000 }); await pg.waitForTimeout(400) };
  const toastText = async pg => (await pg.textContent('#toast')).trim();
  const step = async (pg, sel, label) => { await click(pg, sel); const t = await toastText(pg); console.log(`${label}: ${t}`); return t };
  const re = async pg => { await pg.reload(); await pg.waitForTimeout(2000) };
  const warp = async s => { await p.send('evm_increaseTime', [s]); await p.send('evm_mine', []) };
  const shot = (pg, n) => pg.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });

  const A = await open(agency, 'agency');
  if (!(await A.$('#role-banner'))) console.log('PAGE ERRORS', errs, (await A.content()).slice(0, 600));
  console.log('角色橫幅:', (await A.textContent('#role-banner')).trim());
  await step(A, `#issue-${tD}`, '發行 Dragon 本月 100 顆');
  console.log('本月已發行後，發行按鈕停用:', await A.isDisabled(`#issue-${tD}`));
  await step(A, `#allowhour-${tD}`, '授權 Dragon 信託');
  await step(A, `#deposit-${tD}`, '存入 Dragon 第 1 個月');
  await step(A, `#issue-${tP}`, '發行 Phoenix'); await step(A, `#allowhour-${tP}`, '授權 Phoenix'); await step(A, `#deposit-${tP}`, '存入 Phoenix');
  await shot(A, '1-agency-overview');

  const D = await open(dragon, 'dragon');
  console.log('角色橫幅:', (await D.textContent('#role-banner')).trim());
  await step(D, '#claim', 'Dragon 領第 1 週');
  await D.click('#opt-2'); await D.selectOption('#start', '3'); await D.fill('#price', '1000');
  await step(D, '#request', 'Dragon 開價 1000（低於 8 折，應被擋）');
  await D.fill('#price', '1260');
  await shot(D, '2-consultant-presale');
  await step(D, '#request', 'Dragon 預售第 3–4 週彈性時數 20h 開價 1260');

  await re(A); await step(A, `#approve-${tD}`, '經紀人同意');

  const B = await open(buyer, 'buyer');
  console.log('角色橫幅:', (await B.textContent('#role-banner')).trim());
  await step(B, '#mintbuyer', '承購人領測試幣');
  await step(B, `#buy-${tD}`, '沒授權就購買（應被擋）');
  await shot(B, '3-buyer-market');
  // 原價商店
  console.log('商店文字:', (await B.textContent(`#shop-${tD} p`)).trim());
  await B.fill(`#shopqty-${tD}`, '2'); await B.dispatchEvent(`#shopqty-${tD}`, 'change'); await B.waitForTimeout(200);
  await step(B, `#buyshop-${tD}`, '商店沒授權就買（應被擋）');
  await step(B, `#allowshop-${tD}`, '商店授權 2 小時'); await step(B, `#buyshop-${tD}`, '商店原價買 2 小時');
  console.log('商店買完持有:', (await B.textContent('#myhour')).trim());
  await B.fill(`#shopqty-${tD}`, '99'); await B.dispatchEvent(`#shopqty-${tD}`, 'change'); await B.waitForTimeout(200);
  await step(B, `#allowshop-${tD}`, '授權 99 小時'); await step(B, `#buyshop-${tD}`, '買 99 小時（超過庫存，應被擋）');
  await B.fill(`#shopqty-${tD}`, '1'); await B.dispatchEvent(`#shopqty-${tD}`, 'change');
  // 剛才授權 99 小時的額度還夠，預售那邊會顯示「已授權」
  if (await B.isDisabled(`#allowbuy-${tD}`)) console.log('預售授權: 額度已夠，按鈕顯示', (await B.textContent(`#allowbuy-${tD}`)).trim());
  else await step(B, `#allowbuy-${tD}`, '授權 1260'); await step(B, `#buy-${tD}`, '購買');
  await warp(250); await re(B);
  await step(B, `#claimbought-${tD}`, '第 3 週解鎖後領取');
  console.log('承購人持有:', (await B.textContent('#myhour')).trim());

  await B.click(`#openbook-${tD}`); await B.waitForTimeout(300);
  for (let i = 0; i < 3; i++) await B.click('.slot.free');
  await shot(B, '4-booking-modal');
  await step(B, '#confirm-book', '預約 3 小時');
  console.log('預約後持有:', (await B.textContent('#myhour')).trim());
  await step(B, '[id^=cancelb-]', '取消第一筆預約');

  // 時間推進到第二筆預約開始之後
  const bookings = await new ethers.Contract(hD, art.HourToken.abi, p).getBookings();
  const now = Number((await p.send('eth_getBlockByNumber', ['latest', false])).timestamp);
  await warp(Number(bookings[1].slot) - now + 120); await re(B);
  await step(B, '#noshow-1', '回報顧問沒出現');

  await re(D);
  await shot(D, '5-consultant-ledger');
  await D.click('#offer-1'); await D.waitForTimeout(300);
  console.log('還沒選時段時「提供」按鈕停用:', await D.isDisabled('#confirm-offer'));
  for (let i = 0; i < 2; i++) await D.click('.slot.free');
  console.log('只選 2 個時段時按鈕停用:', await D.isDisabled('#confirm-offer'));
  while (await D.$('.slot.sel')) await D.click('.slot.sel');
  for (let i = 0; i < 3; i++) await D.click('.slot.free');
  await step(D, '#confirm-offer', 'Dragon 提供 3 個補課時段');

  await re(B);
  await shot(B, '6-client-makeup');
  await step(B, '[id^=accept-1-]', '客戶選一個補課時段');
  await re(D); await shot(D, '7-consultant-after');

  // 準備金：Dragon 已有 10 顆，再領的彈性時數進商店
  console.log('Dragon 領取前:', (await D.textContent('#hours .card p')).trim());
  await step(D, '#claim', 'Dragon 再領（準備金滿了，超過的銷毀）');
  console.log('Dragon 領取後:', (await D.textContent('#hours .card p')).trim());

  // 病假：經紀人暫停 → 客戶不能預約 → 顧問請假改時間 → 客戶不接受，拿 2 顆
  await re(A); await step(A, `#pause-${tD}`, '老六按病假暫停');
  await re(B); console.log('暫停中預約按鈕停用:', await B.isDisabled(`#openbook-${tD}`));
  await re(D); await D.click('[id^=leave-]'); await D.waitForTimeout(300);
  for (let i = 0; i < 3; i++) await D.click('.slot.free');
  await shot(D, '9-consultant-leave');
  await step(D, '#confirm-leave', 'Dragon 請假改時間');
  await re(B); await shot(B, '10-client-leave');
  const myHour0 = (await B.textContent('#myhour')).trim();
  await step(B, '[id^=decline-]', '乾爹不接受改時間');
  console.log('乾爹持有:', myHour0, '→', (await B.textContent('#myhour')).trim());
  await re(D); console.log('Dragon 準備金:', (await D.textContent('#hours .card p.muted')).trim());
  await re(A); await step(A, `#pause-${tD}`, '老六恢復');

  // 雙方調價：經紀人提出 80，顧問確認
  await re(A); await A.fill(`#price-${tD}`, '80');
  await step(A, `#propose-${tD}`, '經紀人提出調價 80');
  console.log('提出方不能自己確認（沒有確認按鈕）:', !(await A.$(`#confirmprice-${tD}`)));
  await re(D); await shot(D, '8-consultant-price');
  await step(D, `#confirmprice-${tD}`, 'Dragon 同意調價');
  await re(B); console.log('調價後商店文字:', (await B.textContent(`#shop-${tD} p`)).trim());
  await re(D); console.log('Dragon 錢包:', (await D.textContent('#app')).match(/tUSDC[^A-Za-z]{0,30}/g)?.slice(0,3));
  await re(A); await step(A, `#proposeend-${tD}`, '老六提出提前解約');
  console.log('提出方沒有同意按鈕:', !(await A.$(`#confirmend-${tD}`)));
  await re(D); await shot(D, '11-consultant-end');
  await step(D, `#confirmend-${tD}`, 'Dragon 同意解約');
  await re(B); console.log('解約後商店:', (await B.textContent(`#shop-${tD} p`)).trim());

  console.log('\n頁面錯誤:', errs.length ? errs : '無');
  await b.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1) });
