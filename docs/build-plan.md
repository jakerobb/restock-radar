# The build plan

`/plan` collects the products you intend to use, each with a variant and a
quantity, at live prices, with a total and whether it is all in stock. Nothing
is bought here. From the same derived specs it checks that the plan works: PoE,
ports, rack space, NVR storage and controllers. It can also suggest products
that fix what falls short.

"Add product" opens a quick search (name, SKU, category; arrow keys and Enter,
or click) that adds a product straight to the plan.

## Plans and sharing

- You can keep up to 20 plans in the browser. Everyone starts with one called
  "My Plan"; a switcher on the page renames, adds and deletes them.
- A name is up to 50 characters and unique among your plans (capitals don't
  count). A clash is refused.
- A short link, `/plan/{slug}`, carries a plan to someone else. The slug holds
  the plan's name, then each line's variant number and quantity, and the
  choices below that belong to the plan (how switches are powered, which
  controllers you run yourself).
- Whoever opens it sees the name and can save a copy, under that name or one
  they type. A name already taken is suggested as "name (2)".

Converting a plan to another region and importing one from a UniFi console are
described in the [README](../README.md#web-ui).

## The checks

Every check says "can't tell" where a number isn't known, rather than guessing.

### Tech specs

A product whose tech specs aren't known yet (newly announced, or not collected
from the store yet) is listed first, because the other checks leave it out.
The answer is then "Unsure" unless something is plainly wrong, which is still
"No".

A product the store publishes no specs for, and none are expected (a cable, a
bracket), is left out of that list. An editor marks it on its product page or
in the status page's list, and the mark covers it in every region.

### PoE

- The PoE devices must fit the switches' budgets, and there must be ports of a
  high enough class for them (a PoE++ device needs a PoE++ port).
- A warning appears when a device has a faster port than the PoE ports it would
  be given (a 10 GbE access point on a 2.5 GbE port).
- Each PoE device is placed on a specific switch and port group, each switch
  with its own budget.

**Switches with several power options.** Some switches have a different PoE
budget for each way they can be powered (the Flex 2.5G PoE: 16 W on PoE+, up to
196 W on its optional 210 W adapter). Such a switch gets a "Power for" choice on
its row, kept with the plan and in its share link.

- Until it is chosen, the PoE check says it can't tell. A switch with its power
  supply in the box needs no choice.
- Choosing an adapter the store sells separately adds it to the plan, one for
  each switch.
- Choosing PoE makes the switch a PoE device on the switch upstream. It draws
  its own power and that of the devices on it, within the budget of the port it
  is plugged into (PoE+ or PoE++ gives that class's figure).
- A product of the same range that comes with an adapter (the Ultra 60W, the
  210W) is also an option, and changes the product.

### Ports and placement

Every device with a network port needs a switch port, and so does every switch,
for its uplink. The gateway needs none; the internet connection isn't modelled.
The plan is wired the way a network builder would:

- **Switches.** The switch with the most SFP-style cages is the root and
  uplinks to the gateway. Every other switch uplinks to the root while it has a
  port, and only then to another switch (flat before deep).
- **Gateway ports** are a last resort among ports that give a device the same
  speed. A device that would run faster on a gateway's port than on any
  switch's takes it, and a switch uplinks to the slowest gateway port that gives
  it its speed, so a faster one stays free.
- **Devices** are placed fastest first, each on the switch nearest the root that
  has a port giving it its best speed, and among ports equally near, on the
  slowest that gives that speed.
- **SFP and copper.** SFP-style cages are preferred for every uplink and for
  devices with an SFP port, then copper. A copper-only device may use a cage
  through a module when no copper port is left; a device with only an SFP port
  needs a cage.
- **Uplinks** keep to ports that aren't PoE where they can. A switch's PoE-in
  port is its own uplink, and a combo pair counts once.

A switch with SFP cages that has to be uplinked over copper for want of a free
cage upstream gets a warning recommending something with more SFP connections
(usually an aggregation switch; a Pro HD with four SFP+ can act as a small one).

### PoE injectors

A PoE device the switches can't power, because the port is below its class (or
isn't PoE) or the switch's budget is spent, can be powered by an injector
instead, when the plan has a switch port to spare. An injector is also used for
a device that a switch would power but slower than it could run.

- An injector counts as a one-port PoE supplier of its own that takes a switch
  port and an AC outlet. What runs through it goes no faster than the port it is
  plugged into, which is why the plan may put an injector on a gateway's 10 GbE
  port. It is drawn under the switch it plugs into, with the device under it.
- The plan is tried both ways, with some devices given to injectors, and the
  arrangement that leaves the fewest devices without a port wins; ties go to the
  fewest below 1 GbE, then the least speed lost, then the fewest on a gateway's
  ports.
- The store gives an injector no ports, class or speed (every one says "Gigabit
  LAN Port", the 10G ones too). They are read from the name ("UniFi 10G PoE++
  Adapter (60W)" gives the class, the watts and the speed), else the "Max. PoE+
  Wattage per Port by PSE" some have, else the output rating (48 V at 0.65 A is
  PoE+). A source that disagrees with the one used is recorded as an issue on
  the product.

### Rack space and outlets

- The rack space of the plan is added up. Desktop equipment that needs a shelf
  is named instead (the Instant and the Cloud Key+ included). The list is
  numbered by rack unit, a 2U device appearing twice, and the OCD panels count
  by the height in their variant.
- A rack-mount accessory in the plan counts its own rack space and takes what it
  holds off the desktop list: six AI Ports, three AI Keys, or one each of a
  Cloud Key+, a Pro Max 16 and a Cloud Gateway Industrial. The store doesn't say
  what an accessory fits, so that is stated in the code.
- Each device that runs on the mains rather than PoE takes an AC outlet; a
  switch counts by the input chosen for it.

### NVRs and storage

With cameras in the plan, the check looks for an NVR with room for them. Each
camera takes 1/capacity of an NVR for its resolution class, a rough linear
estimate. It offers "Find an NVR" when there is none, it is full, or one in the
plan is sold out.

An NVR with drive bays (a UNVR, an ENVR, a Dream Machine) gets a drive choice on
its row: a size (1, 4, 16 or 24 TB, what the store sells) and a number up to its
bays. That puts the drives in the plan with it. For each NVR the check then
gives:

- the effective storage for each way the drives can be protected (two are
  mirrored, three or more RAID 5, nine or more can be RAID 6, an even number
  from four RAID 10);
- how many days of its cameras' footage that holds, at an assumed bitrate for
  each camera by resolution and number of sensors. This is a guess, to be tuned
  against UniFi's capacity calculator.

The same goes for the SSD a gateway is sold with and storage that comes built
in. Gateways that record too (Cloud Gateways, Dream Machines and Routers) count
as NVRs, and the finder may suggest one. The UNVR Instant's built-in PoE ports
take part in the PoE checks.

### Controllers and gateways

The plan needs something to fill each role it uses:

| Role | Needed for |
|---|---|
| Gateway and Network controller | anything on the network. Many products are both; a Cloud Key is only a controller, a UXG-Lite only a gateway |
| Access controller | door hubs, intercoms, readers and kits |
| Talk controller | phones |
| Protect controller | cameras, which the NVR check already covers |

A role filled only by something that can't be bought now counts as missing.

- **Capacity.** The Network controller must manage at least as many UniFi
  devices as the plan has (gateways, switches, access points and the like; a
  published "100+" is a minimum, so exceeding it only warns). The Access
  controller must manage as many hubs as the plan has door hubs, intercoms and
  kits. The largest controller in the plan counts. Protect's limit is the camera
  counts of the NVR check, and Talk states none. A controller whose capacity the
  store doesn't state is offered after those that can be shown to fit.
- **Gateways.** The UXG gateways, which the store files as accessories, count as
  gateways, as does any product stating an IDS/IPS throughput. A gateway is
  always a product. More than one thing running UniFi Network is a warning (a
  site has one; the extras probably belong to another site).
- **Self-hosting.** The Network, Access and Talk controllers can be run on your
  own machine: an entry in the plan, not a product, so with no price or stock.
  It counts as filling the role (capacity isn't checked), is carried in the
  share link and can be removed.
- **Official UniFi Hosting**, the cloud-hosted Network controller (a monthly
  subscription, up to 1,000 devices), is a product like any other. The store
  gives it no specifications, so what it runs is stated in the code.

## Topology

A collapsible "Topology" section draws the plan as a family tree: one
arrangement the checks found, not to scale.

- The gateway is at the top, the switches under what they uplink to, and the
  devices under the switch they were given a port or PoE power on. Identical
  devices share a box with a count unless they are plugged in differently.
- Each box says how it is plugged in: the uplink's speed and port, in the
  warning colour (with the link drawn dashed) when slower than the device could
  do. A switch also shows its spare ports, PoE load and spare PoE ports. Every
  box shows its rack height, wall outlets and, when it can't be had now, its
  stock.
- What has nothing to plug into hangs from the first root as a dashed red box.
- Hovering a check outlines the boxes it is about, and the reverse.
- It sits below the plan, shut on a narrow screen, or across the full width
  above the plan and the checks, open, in the two-column layout. A zoom control
  (50% to 200%) scales it, since it is wider than it is tall.

## The finders

When something falls short, the plan offers to fix it. Each suggestion says how
a switch is powered, and the full list of what would work can be expanded.

**Find a switch** covers a shortfall of PoE power, ports or SFP uplinks. It
tries every PoE switch we track added to the plan (and a few of the same) and
suggests the cheapest that fits, the cheapest at full speed, and the one with
the most room. When no one model does, or two different switches cost less (a
10G one for the access points and a gigabit one for the cameras), it suggests a
pair.

- It is also offered when a port-speed warning or a sold-out switch is the
  problem; a sold-out switch is checked without, and replaced.
- It never suggests a switch that leaves a device below 1 GbE.
- A power filter (AC and PoE by default, DC optional) narrows the list.

**Find a PoE injector** adds each candidate to the plan, one up to as many as
there are devices, and keeps those after which the checks find power, a high
enough class and a port for each. Those run every device at its full speed; a
slower injector is offered only when no other would do. It suggests the
cheapest in stock, a cheaper one that isn't, and, where no one model does or two
kinds cost less (a PoE+ one for the cameras and a PoE++ one for the access
point), a pair.

**Find an NVR** suggests an NVR for cameras that have none or more than it
manages.

**Find a gateway or controller** suggests the cheapest product that fills every
missing role (or a pair when none does), and the one running the most
applications. Gateways are described by their IDS/IPS throughput ("5 Gbps
gateway"). It also offers pairs that fill the roles between them (a Gateway Lite
and a Cloud Key can undercut a console) and self-hosting the Network, Access and
Talk controllers. A controller that is too small is replaced.

The finders can be narrowed to:

- rackmount or not (a switch, gateway or NVR that needs an accessory to go in a
  rack comes with it, priced and added together);
- hot-swappable power supplies (CRPS);
- for gateways, hardware PPPoE acceleration, shadow mode, and a minimum IDS/IPS
  throughput. The store doesn't publish PPPoE acceleration: add it to the
  product as a fact, a flag labelled "PPPoE Hardware Acceleration" that is true.

A product that doesn't state a property isn't taken to have it. The finders
don't consider storage.
