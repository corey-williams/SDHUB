# Service Desk Hub

The service desk's team calendar, schedules and PTO.

- **The page** is hosted free on GitHub Pages, and each person installs it as an app in Edge.
- **The data** stays in a `data.json` file in your Teams/OneDrive folder, and OneDrive syncs it to everyone. GitHub never sees it.

## Tabs

- **Home**: a breakdown of one day, today by default (‹ › or the arrow keys change the day). Region buttons switch between All regions, Bellin, Gundersen, Research and Emplify, and each person's browser remembers their choice. The page shows:
  - each person's shift as a bar on a time graph, with a "Now" line and how many people are on shift each hour
  - start times grouped, for example "7 AM: Taylor, Morgan"
  - **Events** panel, which updates automatically every 30 seconds:
    - **PTO** at the top: who's out that day, plus anyone with PTO pending
    - **Today:** a live feed of up to 10 items. First what's happening now ("Alex is on break · until 3:12 PM"), then what's coming up in time order ("Jordan's shift starts · in 5 min", "Taylor has lunch · in 10 min", "Morgan's shift ends · in 57 min"). For other days it shows that day's schedule with clock times.
    - **Not scheduled:** who has the day off (admins can **Add shift** from here)
  - **Meeting blocks (everyone):** click someone's bar and choose **Add meeting block**. Enter the meeting name and start and end times; the start time defaults to where you clicked. The meeting shows as a striped section on their bar with its name. Click a block to edit or delete it.
    - **Repeats:** a meeting can repeat every day, every week, every 2 weeks or every month (same date), with an optional **Until** date. Repeating blocks show **↻**. It only appears on days the person is working.
    - When you edit or delete a repeating meeting, choose **This day only** (e.g. move or cancel one week's standup) or **Every day in the series**. "Available by hour" doesn't count someone for an hour they spend entirely in meetings.
  - **Adjusting hours (admins):** click someone's bar and choose **Adjust hours** to change their start and end time for that day or a date range, with an optional note. By default it only affects days they normally work; tick **Include their regular days off** to cover every day in the range. It never changes their weekly schedule. Adjusted bars are labeled "Adjusted".
  - **Adding a shift on a day off (admins):** people under "Not scheduled" have an **Add shift** button. Their bar then shows "Extra shift". Remove one from the same window or from Admin → Schedule adjustments.
- **PTO**: a month calendar that shows only time off (approved and pending), filterable by region and person. Click a day to start a request for it. Below the calendar are the request form and the list of requests.
- **Admin** (PIN): approve or deny PTO, and add, edit or remove employees. Each employee has a role (IT Support Technician Associate, IT Support Technician or IT Support Technician Senior), a region and a weekly schedule. The team list is grouped by region.
  - **Breaks & lunch:** in **Edit employee**, switch on Break 1, Lunch and/or Break 2, and set each one's start time and length. They're the same on every working day. On Home they show as grey striped sections in the person's shift bar (hover for exact times). They count as "not available" for coverage, like meetings, so a region with everyone at lunch shows a gap.
  - **Employee info:** each employee can have an Employee ID, an employee number (only if different), email, phone and start date. All are optional. Employee IDs must be unique, and 10-digit phone numbers are formatted automatically. The team list shows these under each name, with email and phone as clickable links and time with the company next to the start date.
  - **Supervisors:** in **Edit employee**, turn on **Supervisor** and type or **Generate** a PIN. Supervisors sign in on the Admin tab with that PIN.
    - They can: approve, deny and reopen PTO; adjust hours and add shifts; see coverage alerts; add, edit and remove employees, including employee info and schedules.
    - They can't: turn supervisor access on or off, see or change any PIN, remove a supervisor, or change settings or coverage hours.
    - Only the admin can see a supervisor's PIN (**Show**) or reset it (type a new one). After a page reload, the admin is asked for the admin PIN again before a PIN is shown.
    - In `data.json` the PIN is only stored hashed and encrypted with the admin PIN, never as readable text. Changing the admin PIN re-encrypts all supervisor PINs automatically.
  - **Coverage hours:** set **per region** as one start and end time plus the days it applies (default Mon–Fri 6 AM – 5 PM), e.g. Bellin 6 AM – 5 PM, Gundersen 7:30 AM – 6 PM. **Each region is checked on its own:** a region is covered only when one of its own people is on shift and not in a meeting. Turn checking on or off per region with the **Gap alerts** switches under Settings → Regions. Hidden regions and regions with nobody in them aren't checked. When a region has a gap:
    - Home shows a red **No coverage** banner naming the region (for example "Gundersen 6 AM – 7:30 AM (1.5 hrs)") and shades the gap over that region's rows. On a single region's tab, only that region is shown.
    - adjusting hours, approving PTO or adding a meeting that causes a gap in that person's region shows a warning right away
    - Admin lists gaps for the next 14 days by day and region, each with a **View** button that opens that day
  - **Settings → Regions:** show or hide each region. Emplify starts hidden. A hidden region and everyone in it are left off the Home and PTO tabs, including "All regions". They still show in Admin, so nothing is lost when the region is turned back on.

## Files

**Upload these to GitHub** (the app itself):

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page, its look and its logic |
| `manifest.webmanifest`, `sw.js` | What lets Edge install it as an app |
| `favicon.png`, `app-icon-192.png`, `app-icon-512.png`, `app-icon-maskable-512.png` | Tab and app icons |

**Never upload** `data.json` or any `data-….json`. That's your team's data, and it stays in OneDrive. `.gitignore` blocks it if you ever use git, but the GitHub website's upload page ignores that rule, so double-check before uploading.

## One-time setup: publish the page (you)

1. On github.com, click **+ → New repository**. Name it e.g. `service-desk-hub`, choose **Public** (required for free GitHub Pages) and click **Create repository**.
2. Click **uploading an existing file**, drag in the 9 files listed above, and click **Commit changes**.
3. Go to **Settings → Pages**. Under **Branch**, pick `main` and `/ (root)`, then click **Save**.
4. After a minute or two, the page shows your address, e.g. `https://yourname.github.io/service-desk-hub/`.

To update the app later, upload the changed files the same way. Everyone gets them the next time they open it.

## One-time setup: the data folder (you)

1. In your Teams channel, open **Files** and create a folder, e.g. `Service Desk Hub`.
2. Click **Sync** (or **Add shortcut to My files**) so it appears in File Explorer under OneDrive.
3. In File Explorer, right-click the folder and choose **Always keep on this device**.

## Installing it (everyone, once)

1. Sync the Teams folder (steps above).
2. Open your GitHub Pages address in **Edge**. Click **⋯ → Apps → Install this site as an app**, or the install icon in the address bar.
3. In the app, click **Choose folder**, pick the synced `Service Desk Hub` folder, and click **Allow**. The first person clicks **Create data.json here**.
4. The first time, go to **Admin**, sign in with PIN `1234`, change the PIN under **Settings**, and add your team.

From then on, open **Service Desk Hub** from the Start menu or taskbar. Installed apps keep folder access, so nobody has to reconnect or allow again.

## How it works

- Every change re-reads `data.json`, applies only that change and saves. This keeps you from overwriting changes others made earlier.
- The page re-checks the file every 5 seconds, so changes from others appear as OneDrive syncs them in (usually within a few seconds to a minute).
- **Conflicts:** if two people save at nearly the same moment on different PCs, OneDrive keeps one version and saves the other as a copy like `data-LAPTOP123.json`. The Admin tab warns when it sees one. Re-enter the missing change and delete the copy.
- **Undo:** OneDrive/SharePoint keeps version history. Right-click `data.json` and choose **Version history** to restore an earlier copy.
- **The admin PIN is not real security.** Anyone who can edit the folder can edit `data.json`. Limit folder edit permissions if that matters.

## Requirements

Microsoft Edge or Google Chrome on Windows or Mac. Firefox, Safari, phones and the Teams app can't save to the file.

Only the page code is public on GitHub. It contains no team data, no PINs (only the starting PIN `1234`, which you change) and no contact info. Those all live in `data.json` in OneDrive.
