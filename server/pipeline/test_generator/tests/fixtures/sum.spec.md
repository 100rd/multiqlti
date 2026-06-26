# OpenSpec: Sum Function

## Overview
A utility module exporting a single function `sum` that returns the arithmetic sum of two values.

## Functional Requirements
1. **Arithmetic Addition**: Must accept two numerical arguments and return their mathematical sum.
2. **Input Validation**: Must validate that both parameters are of type `number`. If either parameter is not a number, it must throw a standard `TypeError` with the exact message: `"Arguments must be numbers"`.
3. **Number Systems**: Must correctly handle positive integers, negative integers, zero, and floating-point values.

## API Contract
- **Export**: Named export or default export `sum`.
- **Arguments**:
  - `a`: `number`
  - `b`: `number`
- **Returns**: `number`

## Explicit Test Cases
- `sum(1, 2)` outputs `3`
- `sum(-5, 5)` outputs `0`
- `sum(1.5, 2.25)` outputs `3.75`
- `sum("1", 2)` throws `TypeError("Arguments must be numbers")`
- `sum(5, undefined)` throws `TypeError("Arguments must be numbers")`
