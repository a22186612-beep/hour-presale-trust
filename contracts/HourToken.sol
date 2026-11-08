// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title 顧問時數幣（每位顧問一種代幣，1 顆 = 該顧問 1 小時的服務）
/// @notice 發行：每個月只能發行一次，一次 100 顆給經紀人；沒有其他增發方式。decimals = 0。
///         兌換：持有人在預約表選顧問的空檔（每天台灣時間 10:00–24:00，每格 1 小時），預約幾小時就銷毀幾顆。
///               取消預約不退代幣。
///         違約：預約時間開始後，客戶可以回報顧問沒出現。顧問要提供至少 3 個空檔讓客戶挑一個補課；
///               客戶不接受的話，合約從顧問錢包轉 2 顆代幣給客戶（顧問不夠時由經紀人代賠）。
///               顧問認為回報不實，可請經紀人裁決。
///         請假：顧問臨時有事，要在時段開始前改時間：一樣提供至少 3 個空檔，客戶選一個，或改拿 2 顆賠償。
///         病假暫停：經紀人按暫停後不開放新的預約（信託的商店、預售也一起停）；已經約好的時段不會自動取消。
///         準備金：顧問錢包裡的代幣只用來賠償，顧問不能自己轉出或賣掉（避免繞過經紀人審核和雙方調價）。
contract HourToken is ERC20 {
    enum Status {
        Booked,        // 已預約
        Cancelled,     // 客戶取消（不退代幣）
        NoShow,        // 客戶回報顧問沒出現，等顧問提出補課時段
        MakeupOffered, // 顧問已提出補課時段，等客戶選擇
        MadeUp,        // 客戶接受補課（另產生一筆新的預約）
        Compensated,   // 客戶不接受補課，已賠 2 顆
        Dismissed      // 經紀人裁定回報不成立
    }

    struct Booking {
        address client;
        uint64 slot;     // 這一小時開始的 Unix 時間（整點）
        Status status;
        bool makeup;     // 是不是補課產生的預約（沒有消耗代幣）
        bool leave;      // 是不是顧問請假改時間（不是客戶回報沒出現）
    }

    uint256 public constant MONTHLY_ISSUE = 100;
    uint256 public constant COMPENSATION = 2;
    uint256 public constant MIN_MAKEUP_OPTIONS = 3;
    uint256 public constant MAX_SLOTS_PER_CALL = 20;
    uint256 public constant OPEN_HOUR = 10;   // 台灣時間 10:00 開始
    uint256 public constant CLOSE_HOUR = 24;  // 最後一格是 23:00–24:00
    uint256 public constant TZ_OFFSET = 8 hours;
    uint256 public constant BOOKING_WINDOW = 30 days; // 最多預約 30 天內的時段

    address public immutable agency;
    address public immutable consultant;
    string public consultantName;
    uint256 public immutable launchTime;
    uint256 public immutable monthLength; // 一「個月」幾秒，demo 可設 480

    bool public paused; // 病假暫停：不開放新的預約

    mapping(uint256 => bool) public issuedInMonth;
    Booking[] private bookings;
    mapping(uint64 => uint256) private slotBooking; // 時段 → 預約編號 + 1（0 代表空）
    mapping(uint64 => uint256) private slotHold;    // 時段 → 保留給哪筆違約補課（預約編號 + 1）
    mapping(uint256 => uint64[]) private makeupOffers;

    event Issued(uint256 indexed month, uint256 amount);
    event Booked(uint256 indexed id, address indexed client, uint64 slot, bool makeup);
    event BookingCancelled(uint256 indexed id, address indexed client, uint64 slot);
    event NoShowReported(uint256 indexed id, address indexed client);
    event MakeupOffered(uint256 indexed id, uint64[] slots);
    event MakeupAccepted(uint256 indexed id, uint256 newId, uint64 slot);
    event Compensated(uint256 indexed id, address indexed client, address indexed payer, uint256 amount);
    event NoShowDismissed(uint256 indexed id);
    event Rescheduled(uint256 indexed id, uint64[] slots);
    event PausedSet(bool paused);

    error NotAgency();
    error NotConsultant();
    error NotClient();
    error AlreadyIssued(uint256 nextIssueTime);
    error ConsultantCannotBook();
    error InvalidSlotCount();
    error SlotNotOnHour(uint64 slot);
    error SlotInPast(uint64 slot);
    error SlotTooFar(uint64 slot);
    error OutsideOpenHours(uint64 slot);
    error SlotTaken(uint64 slot);
    error WrongStatus(Status status);
    error TooLateToCancel();
    error NotStartedYet();
    error NotOffered(uint64 slot);
    error CannotCompensate();
    error NoSuchBooking();
    error InvalidConfig();
    error IsPaused();
    error ConsultantCannotTransfer();

    modifier onlyAgency() {
        if (msg.sender != agency) revert NotAgency();
        _;
    }

    modifier onlyConsultant() {
        if (msg.sender != consultant) revert NotConsultant();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address agency_,
        address consultant_,
        string memory consultantName_,
        uint256 monthLength_
    ) ERC20(name_, symbol_) {
        if (agency_ == address(0) || consultant_ == address(0) || agency_ == consultant_ || monthLength_ == 0) {
            revert InvalidConfig();
        }
        agency = agency_;
        consultant = consultant_;
        consultantName = consultantName_;
        monthLength = monthLength_;
        launchTime = block.timestamp;
    }

    /// @notice 1 顆就是 1 小時，不能拆。
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // =========================================================
    // 發行：每個月一次，100 顆給經紀人
    // =========================================================

    function issueMonthly() external onlyAgency {
        uint256 m = currentMonth();
        if (issuedInMonth[m]) revert AlreadyIssued(nextIssueTime());
        issuedInMonth[m] = true;
        _mint(agency, MONTHLY_ISSUE);
        emit Issued(m, MONTHLY_ISSUE);
    }

    /// @notice 持有人銷毀自己的代幣（信託提前結束時用來銷毀未售出的時數）。
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    // =========================================================
    // 兌換：預約顧問的時段
    // =========================================================

    /// @notice 一次預約多個時段，預約幾小時就銷毀幾顆。
    function book(uint64[] calldata slots) external {
        if (msg.sender == consultant) revert ConsultantCannotBook();
        if (paused) revert IsPaused();
        if (slots.length == 0 || slots.length > MAX_SLOTS_PER_CALL) revert InvalidSlotCount();
        _burn(msg.sender, slots.length); // 代幣不夠會丟 ERC20InsufficientBalance
        for (uint256 i = 0; i < slots.length; i++) {
            _requireOpenSlot(slots[i]);
            _record(msg.sender, slots[i], false);
        }
    }

    /// @notice 客戶在時段開始前取消，時段釋出給別人，但代幣不退。
    function cancelBooking(uint256 id) external {
        Booking storage b = _own(id);
        if (b.status != Status.Booked) revert WrongStatus(b.status);
        if (block.timestamp >= b.slot) revert TooLateToCancel();
        b.status = Status.Cancelled;
        slotBooking[b.slot] = 0;
        emit BookingCancelled(id, msg.sender, b.slot);
    }

    // =========================================================
    // 違約處理
    // =========================================================

    /// @notice 時段開始後，客戶回報顧問沒出現。
    function reportNoShow(uint256 id) external {
        Booking storage b = _own(id);
        if (b.status != Status.Booked) revert WrongStatus(b.status);
        if (block.timestamp < b.slot) revert NotStartedYet();
        b.status = Status.NoShow;
        emit NoShowReported(id, msg.sender);
    }

    /// @notice 顧問提出至少 3 個空檔讓客戶選。這些時段會先保留，別人不能預約。
    function offerMakeup(uint256 id, uint64[] calldata slots) external onlyConsultant {
        Booking storage b = _get(id);
        if (b.status != Status.NoShow) revert WrongStatus(b.status);
        if (slots.length < MIN_MAKEUP_OPTIONS || slots.length > MAX_SLOTS_PER_CALL) revert InvalidSlotCount();
        for (uint256 i = 0; i < slots.length; i++) {
            _requireOpenSlot(slots[i]);
            slotHold[slots[i]] = id + 1;
        }
        makeupOffers[id] = slots;
        b.status = Status.MakeupOffered;
        emit MakeupOffered(id, slots);
    }

    /// @notice 客戶從顧問提出的時段選一個補課，不用再付代幣。
    function acceptMakeup(uint256 id, uint64 slot) external {
        Booking storage b = _own(id);
        if (b.status != Status.MakeupOffered) revert WrongStatus(b.status);
        if (slotHold[slot] != id + 1) revert NotOffered(slot);
        if (block.timestamp >= slot) revert SlotInPast(slot);
        _releaseHolds(id);
        b.status = Status.MadeUp;
        uint256 newId = _record(msg.sender, slot, true);
        emit MakeupAccepted(id, newId, slot);
    }

    /// @notice 顧問臨時有事（例如病假），在時段開始前改時間：原時段釋出，提出至少 3 個空檔讓客戶選。
    ///         客戶可以選一個（acceptMakeup），或不接受改拿 2 顆賠償（declineMakeup）。
    function reschedule(uint256 id, uint64[] calldata slots) external onlyConsultant {
        Booking storage b = _get(id);
        if (b.status != Status.Booked) revert WrongStatus(b.status);
        if (block.timestamp >= b.slot) revert TooLateToCancel();
        if (slots.length < MIN_MAKEUP_OPTIONS || slots.length > MAX_SLOTS_PER_CALL) revert InvalidSlotCount();
        slotBooking[b.slot] = 0;
        for (uint256 i = 0; i < slots.length; i++) {
            if (slots[i] == b.slot) revert SlotTaken(slots[i]);
            _requireOpenSlot(slots[i]);
            slotHold[slots[i]] = id + 1;
        }
        makeupOffers[id] = slots;
        b.status = Status.MakeupOffered;
        b.leave = true;
        emit Rescheduled(id, slots);
    }

    /// @notice 客戶不接受補課，改拿 2 顆代幣。
    function declineMakeup(uint256 id) external {
        Booking storage b = _own(id);
        if (b.status != Status.MakeupOffered) revert WrongStatus(b.status);
        _releaseHolds(id);
        b.status = Status.Compensated;
        _compensate(id, b.client);
    }

    /// @notice 顧問還沒提出補課前，經紀人裁決：回報成立就直接賠 2 顆，不成立就駁回。
    function resolveNoShow(uint256 id, bool valid) external onlyAgency {
        Booking storage b = _get(id);
        if (b.status != Status.NoShow) revert WrongStatus(b.status);
        if (valid) {
            b.status = Status.Compensated;
            _compensate(id, b.client);
        } else {
            b.status = Status.Dismissed;
            emit NoShowDismissed(id);
        }
    }

    // =========================================================
    // 病假暫停（經紀人）
    // =========================================================

    function setPaused(bool paused_) external onlyAgency {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // =========================================================
    // 顧問的代幣是賠償準備金，不能自己轉出
    // =========================================================

    function transfer(address to, uint256 value) public override returns (bool) {
        if (msg.sender == consultant) revert ConsultantCannotTransfer();
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (from == consultant) revert ConsultantCannotTransfer();
        return super.transferFrom(from, to, value);
    }

    // =========================================================
    // 內部
    // =========================================================

    function _requireOpenSlot(uint64 slot) private view {
        if (slot % 1 hours != 0) revert SlotNotOnHour(slot);
        if (slot <= block.timestamp) revert SlotInPast(slot);
        if (slot > block.timestamp + BOOKING_WINDOW) revert SlotTooFar(slot);
        uint256 hourOfDay = ((uint256(slot) + TZ_OFFSET) / 1 hours) % 24;
        if (hourOfDay < OPEN_HOUR || hourOfDay >= CLOSE_HOUR) revert OutsideOpenHours(slot);
        if (slotBooking[slot] != 0 || slotHold[slot] != 0) revert SlotTaken(slot);
    }

    function _record(address client, uint64 slot, bool makeup) private returns (uint256 id) {
        id = bookings.length;
        bookings.push(Booking({client: client, slot: slot, status: Status.Booked, makeup: makeup, leave: false}));
        slotBooking[slot] = id + 1;
        emit Booked(id, client, slot, makeup);
    }

    function _releaseHolds(uint256 id) private {
        uint64[] storage s = makeupOffers[id];
        for (uint256 i = 0; i < s.length; i++) {
            if (slotHold[s[i]] == id + 1) slotHold[s[i]] = 0;
        }
    }

    /// @dev 先從顧問錢包扣；顧問不夠時由經紀人代賠。這是代幣規則的一部分，不需要事先授權。
    function _compensate(uint256 id, address client) private {
        address payer;
        if (balanceOf(consultant) >= COMPENSATION) payer = consultant;
        else if (balanceOf(agency) >= COMPENSATION) payer = agency;
        else revert CannotCompensate();
        _transfer(payer, client, COMPENSATION);
        emit Compensated(id, client, payer, COMPENSATION);
    }

    function _get(uint256 id) private view returns (Booking storage) {
        if (id >= bookings.length) revert NoSuchBooking();
        return bookings[id];
    }

    function _own(uint256 id) private view returns (Booking storage b) {
        b = _get(id);
        if (b.client != msg.sender) revert NotClient();
    }

    // =========================================================
    // 查詢（前端用）
    // =========================================================

    function currentMonth() public view returns (uint256) {
        return (block.timestamp - launchTime) / monthLength;
    }

    /// @notice 下一次可以發行的時間；這個月還沒發行就是現在。
    function nextIssueTime() public view returns (uint256) {
        uint256 m = currentMonth();
        if (!issuedInMonth[m]) return block.timestamp;
        return launchTime + (m + 1) * monthLength;
    }

    function isFree(uint64 slot) external view returns (bool) {
        return slotBooking[slot] == 0 && slotHold[slot] == 0;
    }

    function bookingCount() external view returns (uint256) {
        return bookings.length;
    }

    function getBookings() external view returns (Booking[] memory) {
        return bookings;
    }

    function getMakeupOffers(uint256 id) external view returns (uint64[] memory) {
        return makeupOffers[id];
    }
}
