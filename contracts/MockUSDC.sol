// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title 測試用 USDC（6 位小數），任何人都可以自己 mint，只用在 Sepolia demo
contract MockUSDC is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice 水龍頭：mint(你的地址, 1000000000) 就是 1,000 tUSDC
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
