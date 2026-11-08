// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IHourToken is IERC20 {
    function consultant() external view returns (address);
    function agency() external view returns (address);
    function burn(uint256 amount) external;
    function paused() external view returns (bool);
}

/// @title 顧問時數預售信託（每位顧問一份合約）
/// @notice 三個角色：
///         出資人：經紀人。每個月把新發行的 100 顆 $HOUR 存進信託（= 未來 4 週、每週 25 小時），
///                 審核顧問的預售報價；病假暫停在 $HOUR 合約按（暫停時這裡的商店、預售、顧問領取也一起停）。
///         受益人：顧問本人。每週 25 小時拆成兩份：
///                 原價時數（例如 15 小時）：解鎖後放進「原價商店」，任何客戶都能用面額直接買，錢直接進顧問錢包。
///                 彈性時數（例如 10 小時）：顧問急需現金時可以在解鎖前打折預售；沒賣掉的解鎖後由顧問領，
///                 但顧問錢包最多放 10 顆（賠償準備金，不能轉出），超過的直接銷毀。
///                 顧問想換成現金，就要在解鎖前用預售折價賣出。
///         承購人：客戶。在商店用原價買現在的時數，或用折扣價買下顧問「未來某幾週」的彈性時數。
///         預售：顧問指定「從第幾週開始、連續幾週（1–4）、開價多少 tUSDC」，開價要低於面額、不低於 8 折；
///               經紀人同意後開放承購。一筆最多連續 4 週，整個合約期不限筆數。只有經紀人已經存進來的週才能預售。
///         雙方簽核：調價和提前解約都要經紀人和顧問雙方同意（一方提出、另一方確認）才會生效。
contract HourTrust {
    using SafeERC20 for IERC20;
    using SafeERC20 for IHourToken;

    enum Week {
        Pending,     // 還沒領（可能已解鎖，也可能還沒）
        Claimed,     // 顧問已領
        Sold,        // 已預售給承購人，承購人還沒領
        SoldClaimed, // 承購人已領
        Burned       // 提前解約時銷毀（或還沒存入就解約）
    }

    struct SaleRequest {
        uint8 startWeek; // 從第幾週開始（從 1 算起）
        uint8 numWeeks;  // 連續幾週（1–4），0 代表目前沒有請求
        uint256 price;   // 顧問開的總價（tUSDC 最小單位）
        bool approved;   // 經紀人同意
    }

    IHourToken public immutable hour;
    IERC20 public immutable usdc;
    address public immutable agency;
    address public immutable consultant;
    string public consultantName;
    uint256 public immutable hoursPerWeek;  // 每週解鎖幾顆，例如 25
    uint256 public immutable shopHours;     // 其中放進原價商店的時數，例如 15（其餘是彈性時數）
    uint256 public immutable totalWeeks;    // 例如 12
    uint256 public immutable weeksPerMonth; // 例如 4（100 顆 = 4 週 × 25）
    uint256 public immutable periodLength;  // 一「週」幾秒，demo 可設 120
    uint256 public hourPrice;               // 每小時面額（tUSDC 最小單位），經紀人和顧問雙方同意才能調整

    uint8 public constant MAX_ADVANCE_WEEKS = 4; // 一筆預售最多連續 4 週（整個合約期不限筆數，靠 8 折下限保護）
    uint256 public constant CONSULTANT_RESERVE = 10; // 顧問錢包最多放幾顆（賠償準備金）
    uint256 public constant MIN_PRICE_BPS = 8_000;

    uint256 public startTime;
    uint256 public fundedMonths;
    bool public ended;
    Week[] private weekState;
    address[] private weekBuyer;
    SaleRequest public request;
    uint8 public advancedWeeks; // 累計已預售幾週（只做紀錄）
    uint256 public shopSold;       // 原價商店累計賣出幾小時
    uint256 public pendingPrice;   // 提出中的新面額（0 代表沒有）
    address public priceProposer;  // 誰提出的
    address public endProposer;    // 誰提出提前解約（0 代表沒有）

    event Funded(uint256 month, uint256 amount, uint256 startTime);
    event Claimed(address indexed consultant, uint256 weeksClaimed, uint256 amount);
    event SaleRequested(uint8 startWeek, uint8 numWeeks, uint256 price);
    event SaleListed(uint8 startWeek, uint8 numWeeks, uint256 price);
    event SaleCancelled(address indexed by);
    event Sold(address indexed buyer, uint256 firstWeek, uint8 numWeeks, uint256 price);
    event BuyerClaimed(address indexed buyer, uint256 weeksClaimed, uint256 amount);
    event ReserveOverflowBurned(uint256 amount);
    event EndProposed(address indexed by);
    event EndProposalCancelled(address indexed by);
    event ShopSold(address indexed buyer, uint256 amount, uint256 paid);
    event PriceProposed(address indexed by, uint256 newPrice);
    event PriceProposalCancelled(address indexed by);
    event HourPriceSet(uint256 oldPrice, uint256 newPrice);
    event TrustEnded(uint256 burned);

    error NotAgency();
    error NotConsultant();
    error NotFunded();
    error AllFunded();
    error IsPaused();
    error IsEnded();
    error NothingToClaim();
    error InvalidWeeks(uint8 numWeeks);
    error WeeksNotAvailable(uint8 startWeek);
    error WeeksNotFunded(uint256 fundedWeeks);
    error PeriodStarted(uint8 startWeek);
    error PriceOutOfRange(uint256 minPrice, uint256 faceValue);
    error RequestPending();
    error NoRequest();
    error AlreadyApproved();
    error NotListed();
    error InsiderCannotBuy();
    error InvalidConfig();
    error InvalidAmount();
    error NotEnoughStock(uint256 available);
    error NotParty();
    error NoProposal();
    error ProposerCannotConfirm();

    modifier onlyAgency() {
        if (msg.sender != agency) revert NotAgency();
        _;
    }

    modifier onlyConsultant() {
        if (msg.sender != consultant) revert NotConsultant();
        _;
    }

    constructor(
        address hour_,
        address usdc_,
        string memory consultantName_,
        uint256 hoursPerWeek_,
        uint256 shopHours_,
        uint256 totalWeeks_,
        uint256 weeksPerMonth_,
        uint256 hourPrice_,
        uint256 periodLength_
    ) {
        if (
            hour_ == address(0) || usdc_ == address(0) || hoursPerWeek_ == 0 || shopHours_ >= hoursPerWeek_
                || weeksPerMonth_ == 0
                || totalWeeks_ == 0 || totalWeeks_ > 52 || totalWeeks_ % weeksPerMonth_ != 0 || hourPrice_ == 0
                || periodLength_ == 0
        ) revert InvalidConfig();
        hour = IHourToken(hour_);
        usdc = IERC20(usdc_);
        agency = hour.agency();       // 角色直接讀 $HOUR 合約，兩份合約的角色一定一致
        consultant = hour.consultant();
        consultantName = consultantName_;
        hoursPerWeek = hoursPerWeek_;
        shopHours = shopHours_;
        totalWeeks = totalWeeks_;
        weeksPerMonth = weeksPerMonth_;
        hourPrice = hourPrice_;
        periodLength = periodLength_;
        for (uint256 i = 0; i < totalWeeks_; i++) {
            weekState.push(Week.Pending);
            weekBuyer.push(address(0));
        }
    }

    // =========================================================
    // 出資人（經紀人）：每月存入
    // =========================================================

    /// @notice 經紀人先對 $HOUR approve 本合約，再呼叫這裡存入下一個月的時數（4 週 × 25 = 100 顆）。
    ///         第一次存入時開始計時，第 1 週當下解鎖。
    function deposit() external onlyAgency {
        if (ended) revert IsEnded();
        if (fundedMonths * weeksPerMonth >= totalWeeks) revert AllFunded();
        uint256 amount = monthlyAmount();
        if (startTime == 0) startTime = block.timestamp;
        fundedMonths++;
        hour.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(fundedMonths, amount, startTime);
    }

    // =========================================================
    // 受益人（顧問）：按週領取
    // =========================================================

    /// @notice 一次領完已解鎖、已存入、還沒領的週的「彈性時數」（已預售的週不算；原價時數在商店賣）。暫停中不能領。
    ///         顧問錢包最多放 CONSULTANT_RESERVE 顆（賠償準備金），超過的直接銷毀。
    function claim() external onlyConsultant {
        if (startTime == 0) revert NotFunded();
        if (paused()) revert IsPaused();
        uint256 upTo = _min(unlockedWeeks(), fundedWeeks());
        uint256 count;
        for (uint256 i = 0; i < upTo; i++) {
            if (weekState[i] == Week.Pending) {
                weekState[i] = Week.Claimed;
                count++;
            }
        }
        if (count == 0) revert NothingToClaim();
        (uint256 give, uint256 burned) = _split(count * flexHours());
        if (burned > 0) {
            hour.burn(burned);
            emit ReserveOverflowBurned(burned);
        }
        if (give > 0) hour.safeTransfer(consultant, give);
        emit Claimed(consultant, count, give);
    }

    // =========================================================
    // 受益人：預售未來的週；出資人：審核
    // =========================================================

    function requestAdvance(uint8 startWeek, uint8 numWeeks, uint256 price) external onlyConsultant {
        if (startTime == 0) revert NotFunded();
        if (ended) revert IsEnded();
        if (paused()) revert IsPaused();
        if (request.numWeeks != 0) revert RequestPending();
        if (numWeeks == 0 || numWeeks > MAX_ADVANCE_WEEKS) revert InvalidWeeks(numWeeks);
        _checkPeriod(startWeek, numWeeks);
        uint256 face = faceValue(numWeeks);
        if (price >= face || price < minPrice(numWeeks)) revert PriceOutOfRange(minPrice(numWeeks), face);
        request = SaleRequest({startWeek: startWeek, numWeeks: numWeeks, price: price, approved: false});
        emit SaleRequested(startWeek, numWeeks, price);
    }

    /// @dev 期間必須全部還沒解鎖、經紀人已經存入、而且還沒被賣出。
    function _checkPeriod(uint8 startWeek, uint8 numWeeks) private view {
        uint256 last = uint256(startWeek) + numWeeks - 1;
        if (startWeek == 0 || last > totalWeeks) revert WeeksNotAvailable(startWeek);
        if (startWeek <= unlockedWeeks()) revert PeriodStarted(startWeek);
        if (last > fundedWeeks()) revert WeeksNotFunded(fundedWeeks());
        for (uint256 i = startWeek - 1; i < last; i++) {
            if (weekState[i] != Week.Pending) revert WeeksNotAvailable(startWeek);
        }
    }

    function cancelAdvance() external onlyConsultant {
        if (request.numWeeks == 0) revert NoRequest();
        delete request;
        emit SaleCancelled(msg.sender);
    }

    /// @notice 經紀人同意這個期間與價格，開放承購。
    function approveAdvance() external onlyAgency {
        if (request.numWeeks == 0) revert NoRequest();
        if (ended) revert IsEnded();
        if (paused()) revert IsPaused();
        if (request.approved) revert AlreadyApproved();
        request.approved = true;
        emit SaleListed(request.startWeek, request.numWeeks, request.price);
    }

    /// @notice 經紀人拒絕，或把已開放的預售下架。
    function rejectAdvance() external onlyAgency {
        if (request.numWeeks == 0) revert NoRequest();
        delete request;
        emit SaleCancelled(msg.sender);
    }

    // =========================================================
    // 原價商店：已解鎖週的原價時數，任何客戶都能用面額買
    // =========================================================

    /// @notice 客戶先對 tUSDC approve 本合約至少 amount × 面額，再呼叫這裡。tUSDC 直接付給顧問，$HOUR 直接給客戶。
    function buyHours(uint256 amount) external {
        if (msg.sender == agency || msg.sender == consultant) revert InsiderCannotBuy();
        if (ended) revert IsEnded();
        if (paused()) revert IsPaused();
        if (amount == 0) revert InvalidAmount();
        uint256 available = shopAvailable();
        if (amount > available) revert NotEnoughStock(available);
        shopSold += amount;
        uint256 paid = amount * hourPrice;
        usdc.safeTransferFrom(msg.sender, consultant, paid);
        hour.safeTransfer(msg.sender, amount);
        emit ShopSold(msg.sender, amount, paid);
    }

    // =========================================================
    // 承購人：購買預售與領取
    // =========================================================

    /// @notice 承購人先對 tUSDC approve 本合約至少 request.price，再呼叫這裡。
    ///         tUSDC 直接從承購人付給顧問；那幾週記在承購人名下。
    function buy() external {
        if (msg.sender == agency || msg.sender == consultant) revert InsiderCannotBuy();
        if (ended) revert IsEnded();
        if (paused()) revert IsPaused();
        if (!isListed()) revert NotListed();
        SaleRequest memory r = request;
        _checkPeriod(r.startWeek, r.numWeeks);
        delete request;
        advancedWeeks += r.numWeeks;
        for (uint256 i = r.startWeek - 1; i < uint256(r.startWeek) - 1 + r.numWeeks; i++) {
            weekState[i] = Week.Sold;
            weekBuyer[i] = msg.sender;
        }
        usdc.safeTransferFrom(msg.sender, consultant, r.price);
        emit Sold(msg.sender, r.startWeek, r.numWeeks, r.price);
    }

    /// @notice 承購人領取自己買下、已經解鎖的週（每週的彈性時數）。暫停、解約都不影響。
    function claimBought() external {
        uint256 unlocked = unlockedWeeks();
        uint256 count;
        for (uint256 i = 0; i < unlocked; i++) {
            if (weekState[i] == Week.Sold && weekBuyer[i] == msg.sender) {
                weekState[i] = Week.SoldClaimed;
                count++;
            }
        }
        if (count == 0) revert NothingToClaim();
        uint256 amount = count * flexHours();
        hour.safeTransfer(msg.sender, amount);
        emit BuyerClaimed(msg.sender, count, amount);
    }

    // =========================================================
    // 出資人：病假暫停、提前解約；調價要經紀人與顧問雙方同意
    // =========================================================

    /// @notice 病假暫停讀 $HOUR 合約的狀態（經紀人在那邊按）。暫停時不開放預約、商店、預售，顧問也不能領；
    ///         已賣出的週不受影響，時間照走。
    function paused() public view returns (bool) {
        return hour.paused();
    }

    /// @notice 經紀人或顧問提出新的每小時面額（例如 70 → 80），要另一方確認才生效。再提一次會蓋掉舊的提案。
    function proposeHourPrice(uint256 newPrice) external {
        if (msg.sender != agency && msg.sender != consultant) revert NotParty();
        if (ended) revert IsEnded();
        if (newPrice == 0 || newPrice == hourPrice) revert InvalidConfig();
        pendingPrice = newPrice;
        priceProposer = msg.sender;
        emit PriceProposed(msg.sender, newPrice);
    }

    /// @notice 另一方確認調價。只影響之後的商店價格與預售報價，已經賣出的 $HOUR 一樣換 1 小時。
    function confirmHourPrice() external {
        if (msg.sender != agency && msg.sender != consultant) revert NotParty();
        if (pendingPrice == 0) revert NoProposal();
        if (msg.sender == priceProposer) revert ProposerCannotConfirm();
        if (request.numWeeks != 0) revert RequestPending();
        emit HourPriceSet(hourPrice, pendingPrice);
        hourPrice = pendingPrice;
        pendingPrice = 0;
        priceProposer = address(0);
    }

    /// @notice 任一方撤回或拒絕調價提案。
    function cancelHourPrice() external {
        if (msg.sender != agency && msg.sender != consultant) revert NotParty();
        if (pendingPrice == 0) revert NoProposal();
        pendingPrice = 0;
        priceProposer = address(0);
        emit PriceProposalCancelled(msg.sender);
    }

    /// @notice 經紀人或顧問提出提前解約，要另一方確認才生效。
    function proposeEnd() external {
        if (msg.sender != agency && msg.sender != consultant) revert NotParty();
        if (startTime == 0) revert NotFunded();
        if (ended) revert IsEnded();
        endProposer = msg.sender;
        emit EndProposed(msg.sender);
    }

    /// @notice 任一方撤回或拒絕解約提案。
    function cancelEnd() external {
        if (msg.sender != agency && msg.sender != consultant) revert NotParty();
        if (endProposer == address(0)) revert NoProposal();
        endProposer = address(0);
        emit EndProposalCancelled(msg.sender);
    }

    /// @notice 另一方確認提前解約：商店關閉、還沒賣出的原價時數全部銷毀；還沒解鎖、還沒賣出的彈性時數銷毀；
    ///         已解鎖沒領的彈性時數仍可由顧問領；已預售的仍屬於承購人。
    function confirmEnd() external {
        if (msg.sender != agency && msg.sender != consultant) revert NotParty();
        if (endProposer == address(0)) revert NoProposal();
        if (msg.sender == endProposer) revert ProposerCannotConfirm();
        if (ended) revert IsEnded();
        ended = true;
        endProposer = address(0);
        delete request;
        uint256 unlocked = unlockedWeeks();
        uint256 funded = fundedWeeks();
        uint256 count;
        for (uint256 i = unlocked; i < totalWeeks; i++) {
            if (weekState[i] == Week.Pending) {
                weekState[i] = Week.Burned;
                if (i < funded) count++;
            }
        }
        uint256 burned = count * flexHours() + funded * shopHours - shopSold;
        pendingPrice = 0;
        priceProposer = address(0);
        if (burned > 0) hour.burn(burned);
        emit TrustEnded(burned);
    }

    // =========================================================
    // 查詢（前端用）
    // =========================================================

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice 每週的彈性時數（可預售、沒賣掉由顧問領）。
    function flexHours() public view returns (uint256) {
        return hoursPerWeek - shopHours;
    }

    /// @notice 原價商店現在可以買幾小時：已解鎖、已存入的週的原價時數，扣掉已賣出的。解約後商店關閉。
    function shopAvailable() public view returns (uint256) {
        if (ended) return 0;
        return _min(unlockedWeeks(), fundedWeeks()) * shopHours - shopSold;
    }

    /// @dev 顧問領取時，多少進顧問錢包、多少超過準備金上限要銷毀。
    function _split(uint256 amount) private view returns (uint256 give, uint256 burned) {
        uint256 bal = hour.balanceOf(consultant);
        uint256 room = bal >= CONSULTANT_RESERVE ? 0 : CONSULTANT_RESERVE - bal;
        give = _min(amount, room);
        burned = amount - give;
    }

    /// @notice 顧問現在按領取的話：幾顆進顧問錢包、幾顆超過上限會銷毀。
    function claimSplit() external view returns (uint256 toConsultant, uint256 burned) {
        return _split(claimable());
    }

    function monthlyAmount() public view returns (uint256) {
        return hoursPerWeek * weeksPerMonth;
    }

    function totalMonths() external view returns (uint256) {
        return totalWeeks / weeksPerMonth;
    }

    function fundedWeeks() public view returns (uint256) {
        return _min(fundedMonths * weeksPerMonth, totalWeeks);
    }

    function unlockedWeeks() public view returns (uint256) {
        if (startTime == 0) return 0;
        return _min((block.timestamp - startTime) / periodLength + 1, totalWeeks);
    }


    /// @notice 預售 n 週的面額（tUSDC）= n × 每週彈性時數 × 每小時面額。
    function faceValue(uint8 numWeeks) public view returns (uint256) {
        return uint256(numWeeks) * flexHours() * hourPrice;
    }

    function minPrice(uint8 numWeeks) public view returns (uint256) {
        return faceValue(numWeeks) * MIN_PRICE_BPS / 10_000;
    }

    /// @notice 建議價（前端預設）：1 週 95 折、2 週 9 折、3 週 85 折、4 週 8 折。
    function suggestedPrice(uint8 numWeeks) public view returns (uint256) {
        if (numWeeks == 0 || numWeeks > MAX_ADVANCE_WEEKS) revert InvalidWeeks(numWeeks);
        return faceValue(numWeeks) * (10_000 - uint256(numWeeks) * 500) / 10_000;
    }

    function isListed() public view returns (bool) {
        return request.numWeeks != 0 && request.approved;
    }

    /// @notice 顧問現在可以領的 $HOUR 顆數。
    function claimable() public view returns (uint256) {
        uint256 upTo = _min(unlockedWeeks(), fundedWeeks());
        uint256 count;
        for (uint256 i = 0; i < upTo; i++) {
            if (weekState[i] == Week.Pending) count++;
        }
        return count * flexHours();
    }

    function buyerClaimable(address buyer) public view returns (uint256) {
        uint256 unlocked = unlockedWeeks();
        uint256 count;
        for (uint256 i = 0; i < unlocked; i++) {
            if (weekState[i] == Week.Sold && weekBuyer[i] == buyer) count++;
        }
        return count * flexHours();
    }

    function nextUnlockTime() external view returns (uint256) {
        uint256 unlocked = unlockedWeeks();
        if (startTime == 0 || unlocked >= totalWeeks) return 0;
        return startTime + unlocked * periodLength;
    }

    /// @notice 每一週的狀態：0 未領、1 顧問已領、2 已預售、3 承購人已領、4 已銷毀。
    function getWeeks() external view returns (Week[] memory) {
        return weekState;
    }

    function getBuyers() external view returns (address[] memory) {
        return weekBuyer;
    }

    /// @notice 合約裡還有幾顆 $HOUR。
    function balance() external view returns (uint256) {
        return hour.balanceOf(address(this));
    }
}
