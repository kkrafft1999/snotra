---
title: See what a chat costs
description: Read the estimated API cost of a chat, split by model and kind of token, and set your own price for a model.
sidebar:
  order: 8
---

[since 1.23] Snotra estimates what a chat has cost so far with a cloud model. It counts the tokens every request used and prices them with a public price table. The figure is an estimate, not your bill.

## What you need

A chat with at least one answer. Nothing has to be set up: the price table ships with Snotra.

## Steps

1. Look at the composer bar, left of the token counter. Once a chat has used tokens, the estimate appears there, for example *~$0.42*.
2. Click it. A panel opens with the sum and, for each model the chat used, its tokens and cost: input, read from the cache, written to the cache, and output, including reasoning.
3. To close the panel, click the figure again, click elsewhere or press `Esc`.

The history shows the same estimate next to each chat's time; see [Continue an earlier chat](../chat-history/).

## What happens

- **The sum covers the whole chat.** Every request counts, including the rounds in which Snotra uses tools. If you switch models within a chat, each model keeps its own line at its own price. The sum is saved with the chat and comes back when you open it again.
- **Each kind of token has its own price.** Reading from the prompt cache is cheaper than plain input, and writing to it can cost more. Reasoning is billed as output.
- **A model on your computer costs nothing.** Ollama, LM Studio and other servers at a local address show *$0.00*: there is no API bill.
- **An unknown model shows a dash.** If the table has no price for a model, its cost shows *–*, never *$0.00*. A sum that leaves such requests out ends in *+*, for example *~$0.42+*.
- **What is not included:** image generation, voice input and the generated chat title. Batch, priority and long-context surcharges and regional prices are not modelled; the table's list price applies.

The cost is not a replacement for your provider's bill. Rounding, discounts and price changes can make the actual amount differ.

## Prices of your own

*Settings › Models* lists every model of your list under *Prices for the cost estimate*, with the price Snotra uses and where it comes from: *Price table*, *Your price*, *Local — free* or *No price known*.

1. Open *Settings › Models* and scroll to *Prices for the cost estimate*.
2. Click *Set price* next to the model — or *Set a price* in the chat's cost panel, which leads to the same place.
3. Enter the price in US dollars per million tokens for *Input* and *Output*. *Cache read* and *Cache write* are optional; left empty, they cost what input costs.
4. Click *Save price*.

Your price always wins — over the table, and over *Local — free* for a server on your computer that forwards to a paid API. *Use table price* removes it again.

## Update the price table

The table comes from [LiteLLM](https://github.com/BerriAI/litellm), a community-maintained list of model prices. Every Snotra release ships a current copy. Snotra does not fetch prices by itself; to get a newer table, click *Update prices* under *Prices for the cost estimate*. The date of the table in use is shown there and at the foot of the cost panel.

If the download fails, the previous table stays in use and Snotra says so.

## If it doesn't work

- **The cost shows *–*.** The table does not know the model, which is common for a model on an OpenAI-compatible server or a deployment with its own name. Set a price of your own for it.
- **The cost looks too high or too low.** Compare the date of the table with your provider's current prices, and click *Update prices*. If you pay a different price, set it as your own.
- **No figure appears.** The chat has no answer yet, or the provider did not report how many tokens were used.
