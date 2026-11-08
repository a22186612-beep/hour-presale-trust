const ganache = require('ganache'); const { ethers } = require('ethers'); const art = require('./artifacts.json');
const DAY = 86400, P = DAY, MONTH = 4 * DAY;           // 測試裡一「週」= 1 天，一「個月」= 4 天
const U = n => BigInt(Math.round(n * 1e6)), f = x => Number(x) / 1e6;
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } };
(async () => {
  const g = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 8 } });
  const prov = new ethers.BrowserProvider(g);
  const [agency, alice, bob, buyer, client2, deployer, stranger] = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(i => prov.getSigner(i)));
  const dep = async (n, ...a) => { const F = new ethers.ContractFactory(art[n].abi, art[n].bytecode, deployer); const c = await F.deploy(...a); await c.waitForDeployment(); return c };
  const usdc = await dep('MockUSDC');
  const hA = await dep('HourToken', 'Alice Hour', 'aHOUR', agency.address, alice.address, 'Alice', MONTH);
  const hB = await dep('HourToken', 'Bob Hour', 'bHOUR', agency.address, bob.address, 'Bob', MONTH);
  const tA = await dep('HourTrust', hA.target, usdc.target, 'Alice', 25, 15, 12, 4, U(70), P);
  const ifaces = [tA.interface, hA.interface, usdc.interface];
  const expectErr = async (p, name, m) => {
    try { await p; ok(false, m + ' (沒被擋下)') } catch (e) {
      const d = e.data || e.info?.error?.data || e.error?.data; let got = '?';
      for (const i of ifaces) { try { got = i.parseError(d).name; break } catch { } }
      if (got === '?') got = String(e.shortMessage || e.message).slice(0, 80);
      ok(got === name, `${m} → ${got}`)
    }
  };
  const C = (c, s) => c.connect(s);
  const tx = async p => (await p).wait();
  const warp = async s => { await prov.send('evm_increaseTime', [s]); await prov.send('evm_mine', []) };
  const now = async () => Number((await prov.send('eth_getBlockByNumber', ['latest', false])).timestamp);
  const W = async t => (await t.getWeeks()).map(Number);
  const hb = async (h, a) => Number(await h.balanceOf(a.address ?? a));
  // 找從 from 之後第 k 個「台灣時間 10:00–24:00」的整點時段
  const twHour = s => Math.floor((s + 8 * 3600) / 3600) % 24;
  const slots = async (k, fromOffset = 3600) => { const out = []; let s = Math.ceil(((await now()) + fromOffset) / 3600) * 3600; while (out.length < k) { if (twHour(s) >= 10) out.push(s); s += 3600 } return out };
  const ST = ['Booked', 'Cancelled', 'NoShow', 'MakeupOffered', 'MadeUp', 'Compensated', 'Dismissed'];
  const bk = async (h, id) => { const b = (await h.getBookings())[id]; return { client: b.client, slot: Number(b.slot), status: ST[Number(b.status)], makeup: b.makeup, leave: b.leave } };

  console.log('部署設定');
  await expectErr(new ethers.ContractFactory(art.HourToken.abi, art.HourToken.bytecode, deployer).getDeployTransaction('x', 'x', agency.address, agency.address, 'x', MONTH).then(t => deployer.call(t)), 'InvalidConfig', '經紀人和顧問同一個地址');
  await expectErr(new ethers.ContractFactory(art.HourTrust.abi, art.HourTrust.bytecode, deployer).getDeployTransaction(hA.target, usdc.target, 'x', 25, 15, 10, 4, U(70), P).then(t => deployer.call(t)), 'InvalidConfig', '總週數不是整月');
  await expectErr(new ethers.ContractFactory(art.HourTrust.abi, art.HourTrust.bytecode, deployer).getDeployTransaction(hA.target, usdc.target, 'x', 25, 25, 12, 4, U(70), P).then(t => deployer.call(t)), 'InvalidConfig', '原價時數不能占滿整週');
  ok(Number(await tA.shopHours()) === 15 && Number(await tA.flexHours()) === 10, '每週 25 小時 = 原價 15 + 彈性 10');
  ok(await tA.agency() === agency.address && await tA.consultant() === alice.address, '信託的經紀人、顧問直接讀自 $HOUR 合約');
  ok(Number(await hA.decimals()) === 0, '$HOUR 沒有小數，1 顆 = 1 小時');

  console.log('每月發行 $HOUR');
  await expectErr(C(hA, stranger).issueMonthly.staticCall(), 'NotAgency', '外人發行');
  await expectErr(C(hA, alice).issueMonthly.staticCall(), 'NotAgency', '顧問自己發行');
  await tx(C(hA, agency).issueMonthly());
  ok(await hb(hA, agency) === 100 && Number(await hA.totalSupply()) === 100, '第 1 個月發行 100 顆給經紀人');
  await expectErr(C(hA, agency).issueMonthly.staticCall(), 'AlreadyIssued', '同一個月發行第二次');
  ok(!hA.interface.getFunction('mint'), '合約沒有 mint 增發函式');

  console.log('經紀人存入第 1 個月');
  await expectErr(C(tA, stranger).deposit.staticCall(), 'NotAgency', '外人存入');
  await expectErr(C(tA, alice).claim.staticCall(), 'NotFunded', '還沒存入就領');
  await expectErr(C(tA, alice).requestAdvance.staticCall(3, 1, U(1600)), 'NotFunded', '還沒存入就預售');
  await expectErr(C(tA, agency).deposit.staticCall(), 'ERC20InsufficientAllowance', '沒先授權 $HOUR 就存入');
  await tx(C(hA, agency).approve(tA.target, 300));
  await tx(C(tA, agency).deposit());
  ok(Number(await tA.balance()) === 100 && Number(await tA.fundedWeeks()) === 4, '存入 100 顆 = 第 1–4 週');
  ok(Number(await tA.unlockedWeeks()) === 1, '存入當下第 1 週解鎖');
  await expectErr(C(tA, agency).deposit.staticCall(), 'ERC20InsufficientBalance', '這個月的時數已經用完，不能提前存下個月');

  console.log('顧問按週領取');
  await tx(C(tA, alice).claim()); ok(await hb(hA, alice) === 10, 'Alice 領到第 1 週的彈性時數 10 顆（原價 15 小時在商店）');
  await expectErr(C(tA, alice).claim.staticCall(), 'NothingToClaim', '同一週領兩次');
  await expectErr(C(tA, bob).claim.staticCall(), 'NotConsultant', 'Bob 領 Alice 的時數');
  await expectErr(C(tA, agency).claim.staticCall(), 'NotConsultant', '經紀人代領');

  console.log('顧問預售：指定期間與開價');
  ok(f(await tA.faceValue(1)) === 700 && f(await tA.minPrice(2)) === 1120, '預售 1 週面額 10 × 70 = 700；2 週最低 1,120');
  ok(f(await tA.suggestedPrice(1)) === 665 && f(await tA.suggestedPrice(4)) === 2240, '建議價 1 週 95 折、4 週 8 折');
  await expectErr(C(tA, alice).requestAdvance.staticCall(1, 1, U(1600)), 'PeriodStarted', '預售已解鎖的第 1 週');
  await expectErr(C(tA, alice).requestAdvance.staticCall(5, 1, U(1600)), 'WeeksNotFunded', '預售還沒存入的第 5 週');
  await expectErr(C(tA, alice).requestAdvance.staticCall(3, 5, U(8000)), 'InvalidWeeks', '一次預售 5 週');
  await expectErr(C(tA, alice).requestAdvance.staticCall(3, 2, U(1400)), 'PriceOutOfRange', '開價等於面額');
  await expectErr(C(tA, alice).requestAdvance.staticCall(3, 2, U(1119)), 'PriceOutOfRange', '開價低於 8 折');
  await expectErr(C(tA, agency).requestAdvance.staticCall(3, 2, U(1260)), 'NotConsultant', '經紀人替顧問開價');
  await expectErr(C(tA, buyer).buy.staticCall(), 'NotListed', '沒有預售時購買');
  await tx(C(tA, alice).requestAdvance(3, 2, U(1260)));
  await expectErr(C(tA, alice).requestAdvance.staticCall(4, 1, U(1600)), 'RequestPending', '已有一筆掛單再開一筆');
  await expectErr(C(tA, buyer).buy.staticCall(), 'NotListed', '經紀人還沒同意就購買');
  await expectErr(C(tA, alice).approveAdvance.staticCall(), 'NotAgency', '顧問自己同意');
  await tx(C(tA, agency).approveAdvance()); ok(await tA.isListed(), '經紀人同意：開放承購');
  await expectErr(C(tA, agency).approveAdvance.staticCall(), 'AlreadyApproved', '重複同意');

  console.log('承購人用 tUSDC 購買');
  await tx(C(usdc, buyer).mint(buyer.address, U(20000)));
  await expectErr(C(tA, agency).buy.staticCall(), 'InsiderCannotBuy', '經紀人自己買');
  await expectErr(C(tA, alice).buy.staticCall(), 'InsiderCannotBuy', '顧問自己買');
  await expectErr(C(tA, buyer).buy.staticCall(), 'ERC20InsufficientAllowance', '承購人沒先授權 tUSDC');
  await tx(C(usdc, buyer).approve(tA.target, U(1260)));
  await tx(C(tA, buyer).buy());
  ok(f(await usdc.balanceOf(alice.address)) === 1260, '1,260 tUSDC 直接進 Alice 錢包');
  ok(Number(await tA.balance()) === 90, '合約裡的 $HOUR 沒動（商店 60 + 第 2–4 週彈性 30）');
  let w = await W(tA); ok(w[2] === 2 && w[3] === 2 && w[1] === 0, '第 3、4 週標為已預售');
  ok((await tA.getBuyers())[2] === buyer.address, '第 3 週記在承購人名下');
  await expectErr(C(tA, buyer).claimBought.staticCall(), 'NothingToClaim', '第 3 週還沒解鎖就領');

  console.log('時間推進：解鎖後各自領取');
  await warp(2 * P + 60);
  ok(Number(await tA.unlockedWeeks()) === 3, '第 3 週解鎖');
  await tx(C(tA, buyer).claimBought()); ok(await hb(hA, buyer) === 10, '承購人領到第 3 週的 10 顆');
  ok(Number((await tA.claimSplit())[0]) === 0 && Number((await tA.claimSplit())[1]) === 10, '預覽：Alice 已有 10 顆，第 2 週的 10 小時會銷毀');
  const supC = Number(await hA.totalSupply());
  await tx(C(tA, alice).claim());
  ok(await hb(hA, alice) === 10 && Number(await hA.totalSupply()) === supC - 10, 'Alice 準備金已滿 10 顆，第 2 週的 10 小時直接銷毀（第 3 週屬於承購人）');
  await expectErr(C(hA, alice).transfer.staticCall(buyer.address, 1), 'ConsultantCannotTransfer', '顧問自己轉賣準備金');
  await tx(C(hA, alice).approve(stranger.address, 5));
  await expectErr(C(hA, stranger).transferFrom.staticCall(alice.address, stranger.address, 1), 'ConsultantCannotTransfer', '顧問授權別人代轉也不行');

  console.log('第 2 個月：發行並存入');
  await warp(MONTH);
  await tx(C(hA, agency).issueMonthly()); await tx(C(tA, agency).deposit());
  ok(Number(await tA.fundedWeeks()) === 8 && Number(await tA.unlockedWeeks()) === 7, '已存入 8 週，解鎖到第 7 週');
  ok(Number(await tA.advancedWeeks()) === 2, '已累計預售 2 週（只做紀錄，整個合約期不設上限）');
  await expectErr(C(tA, alice).requestAdvance.staticCall(8, 5, U(2800)), 'InvalidWeeks', '一筆最多連續 4 週');
  await expectErr(C(tA, alice).requestAdvance.staticCall(8, 1, U(559)), 'PriceOutOfRange', '低於 8 折');
  try { await C(tA, alice).requestAdvance.staticCall(8, 1, U(560)); ok(true, '剛好 8 折可以掛單') } catch (e) { ok(false, '剛好 8 折可以掛單 ' + e.message) }
  await tx(C(tA, buyer).claimBought()); ok(await hb(hA, buyer) === 20, '承購人補領第 4 週');

  console.log('原價商店：已解鎖週的原價時數');
  ok(Number(await tA.shopAvailable()) === 105, '解鎖 7 週 × 15 = 105 小時可買');
  await tx(C(usdc, client2).mint(client2.address, U(5000)));
  await expectErr(C(tA, alice).buyHours.staticCall(1), 'InsiderCannotBuy', '顧問在自己商店買');
  await expectErr(C(tA, client2).buyHours.staticCall(0), 'InvalidAmount', '買 0 小時');
  await expectErr(C(tA, client2).buyHours.staticCall(106), 'NotEnoughStock', '買超過庫存');
  await expectErr(C(tA, client2).buyHours.staticCall(3), 'ERC20InsufficientAllowance', '沒先授權 tUSDC');
  const al0 = f(await usdc.balanceOf(alice.address));
  await tx(C(usdc, client2).approve(tA.target, U(210))); await tx(C(tA, client2).buyHours(3));
  ok(await hb(hA, client2) === 3 && f(await usdc.balanceOf(alice.address)) === al0 + 210, '原價買 3 小時：付 210 直接給 Alice，拿到 3 顆');
  ok(Number(await tA.shopAvailable()) === 102 && Number(await tA.shopSold()) === 3, '商店庫存剩 102');

  console.log('經紀人：病假暫停、調整面額');
  await expectErr(C(hA, alice).setPaused.staticCall(true), 'NotAgency', '顧問自己暫停');
  await tx(C(hA, agency).setPaused(true)); ok(await tA.paused(), '信託直接讀 $HOUR 合約的暫停狀態');
  await expectErr(C(hA, buyer).book.staticCall(await slots(1)), 'IsPaused', '暫停中不開放新的預約');
  await expectErr(C(tA, alice).claim.staticCall(), 'IsPaused', '暫停中顧問領取');
  await expectErr(C(tA, alice).requestAdvance.staticCall(8, 1, U(650)), 'IsPaused', '暫停中預售');
  await expectErr(C(tA, client2).buyHours.staticCall(1), 'IsPaused', '暫停中商店不能買');
  await tx(C(hA, agency).setPaused(false));
  await tx(C(tA, alice).requestAdvance(8, 1, U(650)));

  console.log('調價：經紀人與顧問雙方同意');
  await expectErr(C(tA, stranger).proposeHourPrice.staticCall(U(80)), 'NotParty', '外人提出調價');
  await expectErr(C(tA, agency).proposeHourPrice.staticCall(U(70)), 'InvalidConfig', '提出跟現在一樣的價格');
  await expectErr(C(tA, alice).confirmHourPrice.staticCall(), 'NoProposal', '沒有提案就確認');
  await tx(C(tA, agency).proposeHourPrice(U(80)));
  ok(f(await tA.pendingPrice()) === 80 && await tA.priceProposer() === agency.address && f(await tA.hourPrice()) === 70, '經紀人提出 80，還沒生效');
  await expectErr(C(tA, agency).confirmHourPrice.staticCall(), 'ProposerCannotConfirm', '經紀人自己確認自己的提案');
  await expectErr(C(tA, stranger).confirmHourPrice.staticCall(), 'NotParty', '外人確認');
  await expectErr(C(tA, alice).confirmHourPrice.staticCall(), 'RequestPending', '有預售掛單時不能調價');
  await tx(C(tA, agency).rejectAdvance()); ok(Number((await tA.request()).numWeeks) === 0, '經紀人拒絕，掛單作廢');
  await tx(C(tA, alice).confirmHourPrice());
  ok(f(await tA.hourPrice()) === 80 && f(await tA.pendingPrice()) === 0, 'Alice 確認：面額變 80');
  ok(f(await tA.faceValue(1)) === 800, '預售 1 週面額變 800');
  await tx(C(tA, alice).proposeHourPrice(U(120))); await tx(C(tA, agency).cancelHourPrice());
  ok(f(await tA.hourPrice()) === 80 && f(await tA.pendingPrice()) === 0, 'Alice 提 120，經紀人拒絕，維持 80');
  await expectErr(C(tA, alice).cancelHourPrice.staticCall(), 'NoProposal', '沒有提案就撤回');
  await tx(C(usdc, client2).approve(tA.target, U(80))); await tx(C(tA, client2).buyHours(1));
  ok(await hb(hA, client2) === 4, '商店改用新價格 80 賣');
  ok(await hb(hA, buyer) === 20, '承購人手上用舊價格買到的 20 顆一樣是 20 小時');

  console.log('二級市場：$HOUR 可以自由轉讓');
  await tx(C(hA, buyer).transfer(client2.address, 10)); ok(await hb(hA, client2) === 14, '承購人轉 10 顆給另一位客戶');

  console.log('預約兌換');
  const s = await slots(8);
  await expectErr(C(hA, alice).book.staticCall([s[0]]), 'ConsultantCannotBook', '顧問預約自己');
  await expectErr(C(hA, buyer).book.staticCall([]), 'InvalidSlotCount', '沒選時段');
  await expectErr(C(hA, buyer).book.staticCall([s[0] + 60]), 'SlotNotOnHour', '不是整點');
  const past = Math.floor((await now()) / 3600) * 3600 - 3600 * 24;
  await expectErr(C(hA, buyer).book.staticCall([past]), 'SlotInPast', '預約過去的時段');
  let night = s[0]; while (twHour(night) !== 3) night += 3600;
  await expectErr(C(hA, buyer).book.staticCall([night]), 'OutsideOpenHours', '預約凌晨 3 點');
  await expectErr(C(hA, buyer).book.staticCall([s[0] + 31 * DAY]), 'SlotTooFar', '預約 31 天後');
  await expectErr(C(hA, stranger).book.staticCall([s[0]]), 'ERC20InsufficientBalance', '沒有 $HOUR 的人預約');
  await expectErr(C(hA, buyer).book.staticCall([s[0], s[0]]), 'SlotTaken', '同一次選兩個一樣的時段');
  const supply0 = Number(await hA.totalSupply());
  await tx(C(hA, buyer).book([s[0], s[1], s[2]]));
  ok(await hb(hA, buyer) === 7 && Number(await hA.totalSupply()) === supply0 - 3, '預約 3 小時：銷毀 3 顆');
  ok(!(await hA.isFree(s[0])) && Number(await hA.bookingCount()) === 3, '時段被占用、記下 3 筆預約');
  await expectErr(C(hA, client2).book.staticCall([s[1]]), 'SlotTaken', '別人預約同一時段');
  await expectErr(C(hA, client2).cancelBooking.staticCall(1), 'NotClient', '取消別人的預約');
  await expectErr(C(hA, buyer).cancelBooking.staticCall(99), 'NoSuchBooking', '取消不存在的預約');
  await tx(C(hA, buyer).cancelBooking(1));
  ok((await bk(hA, 1)).status === 'Cancelled' && await hA.isFree(s[1]) && await hb(hA, buyer) === 7, '取消：時段釋出、不退代幣');
  await expectErr(C(hA, buyer).cancelBooking.staticCall(1), 'WrongStatus', '取消兩次');
  await tx(C(hA, client2).book([s[1]])); ok((await bk(hA, 3)).client === client2.address, '另一位客戶接著預約釋出的時段');

  console.log('顧問請假：時段開始前改時間');
  const r = await slots(3, 5 * DAY);
  await expectErr(C(hA, buyer).reschedule.staticCall(3, r), 'NotConsultant', '客戶幫顧問改時間');
  await expectErr(C(hA, alice).reschedule.staticCall(3, r.slice(0, 2)), 'InvalidSlotCount', '只給 2 個新時段');
  await expectErr(C(hA, alice).reschedule.staticCall(3, [s[1], r[0], r[1]]), 'SlotTaken', '把原本的時段當新時段');
  await tx(C(hA, alice).reschedule(3, r));
  let rb = await bk(hA, 3);
  ok(rb.status === 'MakeupOffered' && rb.leave && await hA.isFree(s[1]) && !(await hA.isFree(r[0])), '改時間：原時段釋出，3 個新時段先保留');
  const c2 = await hb(hA, client2), al1 = await hb(hA, alice);
  await tx(C(hA, client2).declineMakeup(3));
  ok(await hb(hA, client2) === c2 + 2 && await hb(hA, alice) === al1 - 2 && await hA.isFree(r[0]), '客戶不接受改時間：從顧問準備金賠 2 顆');
  await tx(C(hA, client2).book([s[1]])); // 補回一筆給後面的測試用（編號 4）

  console.log('違約：補課或賠 2 顆');
  await expectErr(C(hA, buyer).reportNoShow.staticCall(0), 'NotStartedYet', '時段還沒開始就回報');
  await warp(s[2] - (await now()) + 60);
  await expectErr(C(hA, buyer).cancelBooking.staticCall(2), 'TooLateToCancel', '時段開始後才取消');
  await tx(C(hA, buyer).reportNoShow(0)); ok((await bk(hA, 0)).status === 'NoShow', '客戶回報第 0 筆顧問沒出現');
  const m = await slots(5);
  await expectErr(C(hA, buyer).offerMakeup.staticCall(0, m.slice(0, 3)), 'NotConsultant', '客戶自己提補課時段');
  await expectErr(C(hA, alice).offerMakeup.staticCall(0, m.slice(0, 2)), 'InvalidSlotCount', '只給 2 個補課時段');
  await expectErr(C(hA, alice).offerMakeup.staticCall(2, m.slice(0, 3)), 'WrongStatus', '對沒被回報的預約提補課');
  await expectErr(C(hA, alice).reschedule.staticCall(2, m.slice(0, 3)), 'TooLateToCancel', '時段開始後才請假改時間');
  await tx(C(hA, alice).offerMakeup(0, m.slice(0, 3)));
  ok((await bk(hA, 0)).status === 'MakeupOffered' && !(await hA.isFree(m[0])), '顧問提出 3 個時段，先保留起來');
  await expectErr(C(hA, client2).book.staticCall([m[1]]), 'SlotTaken', '別人預約被保留的補課時段');
  await expectErr(C(hA, buyer).acceptMakeup.staticCall(0, m[4]), 'NotOffered', '選一個顧問沒提的時段');
  const bal0 = await hb(hA, buyer);
  await tx(C(hA, buyer).acceptMakeup(0, m[1]));
  const nb = await bk(hA, 5);
  ok((await bk(hA, 0)).status === 'MadeUp' && nb.slot === m[1] && nb.makeup && nb.client === buyer.address, '客戶選第 2 個時段補課，產生新預約');
  ok(await hb(hA, buyer) === bal0 && await hA.isFree(m[0]) && await hA.isFree(m[2]), '補課不扣代幣，其他保留時段釋出');

  await tx(C(hA, buyer).reportNoShow(2));
  await tx(C(hA, alice).offerMakeup(2, [m[0], m[2], m[3]]));
  const a0 = await hb(hA, alice), b0 = await hb(hA, buyer);
  await tx(C(hA, buyer).declineMakeup(2));
  ok((await bk(hA, 2)).status === 'Compensated' && await hb(hA, buyer) === b0 + 2 && await hb(hA, alice) === a0 - 2, '客戶不接受補課：從顧問錢包轉 2 顆給客戶');
  ok(await hA.isFree(m[0]) && await hA.isFree(m[3]), '不接受後保留的時段釋出');

  console.log('經紀人裁決');
  await tx(C(hA, client2).book([m[4]]));
  await warp(m[4] - (await now()) + 60);
  await tx(C(hA, client2).reportNoShow(6));
  await expectErr(C(hA, alice).resolveNoShow.staticCall(6, false), 'NotAgency', '顧問自己駁回');
  await tx(C(hA, agency).resolveNoShow(6, false)); ok((await bk(hA, 6)).status === 'Dismissed', '經紀人駁回不實回報');
  await expectErr(C(hA, client2).reportNoShow.staticCall(6), 'WrongStatus', '被駁回後再回報');

  console.log('顧問沒有代幣時由經紀人代賠（Bob）');
  await tx(C(hB, agency).issueMonthly()); await tx(C(hB, agency).transfer(client2.address, 5));
  const sb = await slots(1); await tx(C(hB, client2).book(sb));
  await warp(sb[0] - (await now()) + 60);
  await tx(C(hB, client2).reportNoShow(0));
  const ag0 = await hb(hB, agency);
  await tx(C(hB, agency).resolveNoShow(0, true));
  ok(await hb(hB, client2) === 6 && await hb(hB, agency) === ag0 - 2, 'Bob 沒有代幣，經紀人代賠 2 顆');

  console.log('提前解約：未售出的時數銷毀');
  const t2 = await dep('HourTrust', hA.target, usdc.target, 'Alice', 25, 15, 12, 4, U(70), P);
  await warp(MONTH); await tx(C(hA, agency).issueMonthly());
  await tx(C(hA, agency).approve(t2.target, 100)); await tx(C(t2, agency).deposit());
  await tx(C(t2, alice).requestAdvance(3, 1, U(630))); await tx(C(t2, agency).approveAdvance());
  await tx(C(usdc, buyer).approve(t2.target, U(630))); await tx(C(t2, buyer).buy());
  await warp(P + 60); // 解鎖到第 2 週
  await expectErr(C(t2, stranger).proposeEnd.staticCall(), 'NotParty', '外人提出解約');
  await expectErr(C(t2, alice).confirmEnd.staticCall(), 'NoProposal', '沒有提案就確認解約');
  await tx(C(t2, alice).proposeEnd()); await tx(C(t2, agency).cancelEnd());
  ok(await t2.endProposer() === ethers.ZeroAddress && !(await t2.ended()), '顧問提解約，經紀人不同意，合約繼續');
  await tx(C(t2, agency).proposeEnd());
  await expectErr(C(t2, agency).confirmEnd.staticCall(), 'ProposerCannotConfirm', '經紀人自己確認解約');
  ok(!(await t2.ended()), '只有一方同意，還沒解約');
  const sup = Number(await hA.totalSupply());
  await tx(C(t2, alice).confirmEnd());
  w = await W(t2);
  ok(w[3] === 4 && w[2] === 2 && w[0] === 0 && w[4] === 4, '第 4 週起未售出的標為銷毀，第 3 週仍屬承購人');
  ok(Number(await hA.totalSupply()) === sup - 70 && Number(await t2.balance()) === 30, '銷毀 70 顆（商店 60 + 第 4 週彈性 10），剩第 1–3 週彈性 30 顆');
  ok(Number(await t2.shopAvailable()) === 0, '解約後商店關閉');
  await expectErr(C(t2, client2).buyHours.staticCall(1), 'IsEnded', '解約後在商店買');
  await expectErr(C(t2, agency).deposit.staticCall(), 'IsEnded', '解約後再存入');
  await expectErr(C(t2, alice).requestAdvance.staticCall(4, 1, U(630)), 'IsEnded', '解約後預售');
  const al2 = await hb(hA, alice), sup2 = Number(await hA.totalSupply());
  await tx(C(t2, alice).claim());
  ok(Number(await t2.claimable()) === 0 && await hb(hA, alice) === 10 && Number(await hA.totalSupply()) === sup2 - (20 - (10 - al2)), `解約後顧問領第 1–2 週：補滿準備金 10 顆，其餘 ${20 - (10 - al2)} 顆銷毀`);
  await warp(P); await tx(C(t2, buyer).claimBought()); ok(Number(await t2.balance()) === 0, '承購人解約後照樣領第 3 週');

  console.log('存滿 3 個月');
  await warp(MONTH); await tx(C(hA, agency).issueMonthly());
  await tx(C(hA, agency).approve(tA.target, 200)); await tx(C(tA, agency).deposit());
  ok(Number(await tA.fundedWeeks()) === 12, '第 3 個月存入：12 週全部到位');
  await warp(MONTH); await tx(C(hA, agency).issueMonthly());
  await expectErr(C(tA, agency).deposit.staticCall(), 'AllFunded', '第 4 個月再存入');

  console.log(`\n${pass} 通過，${fail} 失敗`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1) });
