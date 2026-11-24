import {Card} from './ui/Card'

/** Static page about the project. Each section is a Card with an h2; add or remove sections freely. */
export default function AboutPage() {
  return (
      <main className="mx-auto max-w-3xl px-4 pt-6 pb-12">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">About</h1>
          <a href="/" className="underline">
            ← Restock Radar
          </a>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <Card aria-label="What is Restock Radar?">
            <h2 className="font-semibold">What is Restock Radar?</h2>
            <p className="mt-2">
              Restock Radar is a passion project by <a href="https://jakerobb.dev">Jake Robb</a>. It does cost
              me a bit of money to operate, and I would appreciate anyone who wants to contribute. I do not
              currently have a way to accept money, but I will explore options at some point in the future.
            </p>
            <p className="mt-2">
              Initially, it was intended to be a stock tracker for the Ubiquiti UniFi online store, which was
              (and is, as of this writing) notorious for being out of stock for highly in-demand items &mdash; in
              part due to scalpers and other resellers, who snap up new products and resell them on Amazon and
              elsewhere for huge markups. Ubiquiti&apos;s own system for notifying customers about restocked
              products was terrible (it&apos;s improved significantly in the past year, but still leaves a
              fair amount to be desired).
            </p>
            <p className="mt-2">
              So, Restock Radar was born, and initially I tracked the status and price of just a small handful
              of items. The UniFi Travel Router in the US store was first. I gradually added a handful more.
              As I continued to improve the app, it became apparent that I could track <em>everything</em> in
              the US store for not much more effort; later I added seven other regional stores.
            </p>
            <p className="mt-2">
              Meanwhile, I continued to add features and tweak the user experience. Product comparisons, tech
              specs, new product detection, and the thing I&apos;m perhaps most proud of &mdash; the build
              planner. Put together the collection of products you have and are considering, and Restock Radar
              will highlight any issues with your plan. Do you have enough ports? Enough PoE budget? Did you
              remember to include a power adapter with your Flex 2.5G PoE? Do you have the right controllers?
              And most importantly of all, is everything you need in stock today in your regional store? Once
              everything checks out, it takes just a few clicks to add it all to your cart automatically.
            </p>
          </Card>

          <Card aria-label="Does Ubiquiti know or care?">
            <h2 className="font-semibold">Does Ubiquiti know or care?</h2>
            <p className="mt-2">
              Frankly, I haven&apos;t asked. I hope they don&apos;t mind! I&apos;ve done my best to build this
              in a way that burdens their web servers as little as possible. My hope is that this improves the
              experience of anyone who&apos;s trying to put together a system, and that Ubiquiti sees it as a
              net benefit to their customers. My primary goal is to help.
            </p>
            <p className="mt-2">
              To Ubiquiti: if anyone is reading this and takes issue with what I&apos;m doing, please feel
              free to reach out. I&apos;m <a href="https://www.reddit.com/user/itsjakerobb/">u/itsjakerobb on
              Reddit</a>; DMs are open. I&apos;m also{' '}
              <a href="https://community.ui.com/user/jakerobb2/4a08cd51-978d-4228-aa48-2d73343f05fa">
                jakerobb2 on the UI Community Forums
              </a>. Or, if you love what I&apos;m doing and want to talk about integrating it into your own
              offerings. Whatever &mdash; I&apos;m happy to discuss.
            </p>
            <h3 className="font-semibold">Is this why the site doesn't have any product images?</h3>
            <p className="mt-2">
              Yep, exactly! I don't want to step on any copyright land mines. If you want photos, click on the Store
              link and check them out there.
            </p>
          </Card>

          <Card aria-label="Is it vibe-coded?">
            <h2 className="font-semibold">Is it vibe-coded?</h2>
            <p className="mt-2">
              It depends on how you mean. I am a software engineer; I&apos;ve been building software for forty
              years. I&apos;ve done it the hard way, and I&apos;ve done it the easy way. In 2026,
              it&apos;s <em>much</em> faster for me to let an LLM write code and tests while I act as reviewer
              and product manager. I know what I want and how it should be done; I describe that to the model,
              review the output, and provide feedback if I have any. Repeat until it satisfies my desires and
              meets my expectations.
            </p>
            <p className="mt-2">
              It&apos;s a very different approach to building software than what I&apos;m used to, but
              frankly, it is amazing. I can build incredible tools like this with <em>far</em> less effort
              than I could have before. If not for LLMs, I wouldn&apos;t have the time to do this.
            </p>
            <h3 className="mt-4 font-semibold">But AI is terrible!</h3>
            <p className="mt-2">
              It is; no question! The energy use, the water use, the effect on RAM and storage pricing. The
              shady land deals. The impact on jobs in tons of industries.
            </p>
            <p className="mt-2">
              Unfortunately, it is also our reality for the time being. I&apos;m doing my part to address that
              by voting, speaking out, and being active in my community. At the same time, it&apos;s taking
              over my industry. If I don&apos;t run with it, I will fall far behind my peers in productivity
              and face the loss of my livelihood. I wouldn&apos;t wish that on anyone, and if it happened to
              me, I would be hard-pressed to support my family, let alone continue to advocate for change. I
              can&apos;t say I&apos;m at peace with it, but I am doing my best and for me that&apos;s enough.
            </p>
          </Card>
        </div>
      </main>
  )
}
