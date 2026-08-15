# Intro

I took the Brief document you provided as a starting point, and didn't try too hard to follow what Sessionboard does but rather do better. The app covers all the 'bonus' points mentioned (except hosting the repo on Forge as there's no availability to do that), so it's on Cloudflare, it has a sync to Airtable (using Airtable as the primary data source would have made the app too slow), it's fast, and it has an API.

But then I continued to do online research of pains with conference management software, take advantage of the pain point information that Gene Kim helpfully put on the Discord from his long experience of conference organisation, and thought myself about what could help the process.

This lead to 35 different features which are listed in ./SuppliedExtras.md.

A few key ones: I broke from the standard SaaS web app idiom of having all nav driven by the left hand functions bar. Instead for the main lists you need to deal with, these are in a horizontally tabbed workspace which allows you to navigate your combined data much better, although with the risk of being unfamiliar. I came up with this format from years earlier in my career spent building data systems for small businesses, I had maybe 50 small businesses all happily using this system.

Each tab has a sortable, filterable list of the relevant item (Speakers, Submissions etc) and you click the underlined field value to read the details of each item, click a New button to create a new item, or where you can edit the item, double click for a tab to edit it in.

Then you can shift click an item to make it a Global Filter which means all the other tabs automatically filter to show just the items relevant to this Global Filter item. You can immediately see the tab counts change. If you move up and down the list (you can use arrow keys) of the Global Filter, all the other tabs update as you move. This lets you for instance quickly check the status of all the Submissions one by one.

Another biggie is although it wasn't asked for we made the app as mobile friendly as possible, so you can write reviews sitting in the back of a car.

Also you have an agent-friendly API. Get your agent to read https://kms.r-s.workers.dev/llms.txt, generate an API key on Settings and give it to the agent, and it can drive the API to do work for you.

The nature of this competition is that it's not possible to humanly QA the app as fully as it would ideally need, however if you want to use it I'll be available to quickly fix any issues.