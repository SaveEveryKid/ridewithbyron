'use strict';
// Search landing pages (also suitable as paid-ad destinations). Each shows live Florence
// inventory matching a filter; copy makes no claims beyond what the dealership publishes.
const LANDING = [
  { slug: 'polaris-ranger-for-sale-florence-al', filter: { make: 'Polaris', family: 'Ranger' }, kicker: 'Polaris Ranger · Florence, AL',
    h1: 'Polaris Ranger for Sale in Florence, AL', title: 'Polaris Ranger for Sale in Florence, AL | Ride With Byron',
    desc: 'Shop Polaris Ranger side-by-sides in stock at Shoals Outdoor Sports in Florence, Alabama. Real photos, current prices and a direct line to Byron Green.',
    body: 'Every Ranger below is physically assigned to the Florence store and was re-checked against the dealership’s listing within the last few hours. Whether you need a three-seat work rig, a Crew for the whole family or a NorthStar cab with heat and air, text or call Byron and he’ll walk the lot for you, send extra photos and put real numbers together.' },
  { slug: 'polaris-dealer-florence-al', filter: { make: 'Polaris' }, kicker: 'Polaris · Florence, AL',
    h1: 'Polaris Dealer in Florence, AL', title: 'Polaris Dealer in Florence, AL — Shop With Byron Green',
    desc: 'Looking for a Polaris dealer in Florence, AL? Browse Polaris Ranger, RZR, GENERAL, Sportsman and XPEDITION models in stock at Shoals Outdoor Sports Florence and deal directly with Byron Green.',
    body: 'Shoals Outdoor Sports is the Polaris dealer in Florence, Alabama, and Byron Green is your direct contact there. Browse the Polaris units on the Florence lot right now, then reach Byron for availability, a best quote or a time to come see it in person.' },
  { slug: 'polaris-ranger-near-muscle-shoals', filter: { make: 'Polaris', family: 'Ranger' }, kicker: 'Minutes from Muscle Shoals',
    h1: 'Polaris Ranger Near Muscle Shoals, AL', title: 'Polaris Ranger Near Muscle Shoals, AL | Ride With Byron',
    desc: 'Polaris Rangers near Muscle Shoals, Sheffield and Tuscumbia — in stock at Shoals Outdoor Sports on Florence Blvd. See live inventory and contact Byron Green directly.',
    body: 'The Florence store on Florence Boulevard is a short drive across the river from Muscle Shoals, Sheffield and Tuscumbia. These are the Rangers on the Florence lot today. Tell Byron which one caught your eye and he’ll confirm it’s here before you make the trip.' },
  { slug: 'side-by-sides-for-sale-north-alabama', filter: { type: 'Side-by-Sides' }, kicker: 'UTVs · North Alabama',
    h1: 'Side-by-Sides for Sale in North Alabama', title: 'Side-by-Sides for Sale in North Alabama | Ride With Byron',
    desc: 'New and pre-owned side-by-sides (UTVs) for sale in North Alabama. Live inventory from Shoals Outdoor Sports in Florence with direct contact to Byron Green.',
    body: 'Work, trail, hunting or family — these are the side-by-sides in stock at the Florence store, updated automatically from the dealership’s listings. Byron works with riders from Florence, Muscle Shoals, Athens, Decatur, Huntsville and across the Tennessee line.' },
  { slug: 'polaris-rzr-for-sale-huntsville-al', filter: { make: 'Polaris', family: 'RZR' }, kicker: 'Worth the drive from Huntsville',
    h1: 'Polaris RZR for Sale Near Huntsville, AL', title: 'Polaris RZR for Sale Near Huntsville, AL | Ride With Byron',
    desc: 'Shopping for a Polaris RZR near Huntsville, AL? See RZR models in stock at Shoals Outdoor Sports in Florence and get a straight answer from Byron Green before you drive.',
    body: 'Florence is about an hour and a quarter west of Huntsville. Before you make the drive, text Byron: he’ll confirm the RZR you want is on the lot, send a walk-around and have numbers ready when you arrive.' },
  { slug: 'polaris-sportsman-for-sale-alabama', filter: { make: 'Polaris', family: 'Sportsman' }, kicker: 'Polaris Sportsman · Alabama',
    h1: 'Polaris Sportsman for Sale in Alabama', title: 'Polaris Sportsman for Sale in Alabama | Ride With Byron',
    desc: 'Polaris Sportsman ATVs for sale in Alabama — in stock at Shoals Outdoor Sports Florence. Current prices, real photos and direct contact with Byron Green.',
    body: 'From the Sportsman 450 and 570 to the big-bore 850 and XP 1000, here is every Sportsman on the Florence lot right now.' },
  { slug: 'utv-dealer-near-me', filter: { type: 'Side-by-Sides' }, kicker: 'UTV dealer · The Shoals',
    h1: 'UTV Dealer Near You in the Shoals', title: 'UTV Dealer Near Me — Florence & the Shoals, AL | Ride With Byron',
    desc: 'Looking for a UTV dealer near you in Florence, Muscle Shoals or North Alabama? Browse side-by-sides in stock at Shoals Outdoor Sports Florence and talk to Byron Green directly.',
    body: 'If you’re anywhere around the Shoals, the Florence store is your nearby UTV dealer — and Byron is the person to ask for. Browse what’s in stock, then call or text him directly.' },
  { slug: 'atvs-for-sale-florence-alabama', filter: { type: 'ATVs' }, kicker: 'ATVs · Florence, AL',
    h1: 'ATVs for Sale in Florence, Alabama', title: 'ATVs for Sale in Florence, Alabama | Ride With Byron',
    desc: 'New and used ATVs for sale in Florence, Alabama. Live four-wheeler inventory at Shoals Outdoor Sports Florence, including youth models, with direct contact to Byron Green.',
    body: 'Full-size utility ATVs, sport quads and youth four-wheelers on the Florence lot today. Not sure which size fits your rider or your property? Ask Byron — no pressure, just straight answers.' },
];
const bySlug = new Map(LANDING.map((l) => [l.slug, l]));
module.exports = { LANDING, bySlug };
