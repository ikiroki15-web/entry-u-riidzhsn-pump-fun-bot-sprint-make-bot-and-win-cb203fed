# Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge.svg)](https://make.fun)

Entry for the make.fun Pump.fun Bot Sprint bounty: a trading bot for
pump.fun-style Solana markets that trades paper money on a replay of
recorded chain data.

Strategy: early buy-volume breakout with take-profit, trailing stop,
stop-loss and a max-hold exit, plus strict risk sizing per coin.

## Run

```sh
node main.ts
```

No real money is spent — the bot only trades the replay's paper money.
