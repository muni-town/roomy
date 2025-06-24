// Preset lists of adjectives and names, 5 per letter A–Z
const adjectivesByLetter: Record<string, string[]> = {
  A: ["adventurous", "amazing", "agile", "awesome", "astounding"],
  B: ["brave", "bright", "breezy", "bold", "bouncy"],
  C: ["curious", "clever", "calm", "cheerful", "courageous"],
  D: ["daring", "dazzling", "dynamic", "dependable", "delightful"],
  E: ["eager", "energetic", "enthusiastic", "elegant", "epic"],
  F: ["friendly", "fearless", "fantastic", "funky", "fast"],
  G: ["generous", "gentle", "great", "glorious", "gleaming"],
  H: ["happy", "heroic", "humble", "humorous", "hearty"],
  I: ["imaginative", "intelligent", "incredible", "iconic", "inspiring"],
  J: ["joyful", "jaunty", "jolly", "jubilant", "jazzy"],
  K: ["keen", "kind", "kooky", "knowledgeable", "kinetic"],
  L: ["lively", "loyal", "luminous", "lucky", "legendary"],
  M: ["mighty", "marvelous", "merry", "magical", "majestic"],
  N: ["nimble", "noble", "nifty", "notable", "nurturing"],
  O: ["optimistic", "outstanding", "original", "outrageous", "opulent"],
  P: ["playful", "powerful", "patient", "positive", "peaceful"],
  Q: ["quick", "quirky", "quiet", "quintessential", "quizzical"],
  R: ["radiant", "reliable", "resourceful", "remarkable", "refreshing"],
  S: ["spirited", "sophisticated", "sensational", "spontaneous", "stellar"],
  T: ["talented", "thoughtful", "tenacious", "terrific", "tranquil"],
  U: ["unique", "upbeat", "understanding", "unstoppable", "uplifting"],
  V: ["vibrant", "valiant", "vivacious", "versatile", "victorious"],
  W: ["wise", "wonderful", "witty", "warm", "whimsical"],
  X: ["extraordinary", "xenial", "xerophytic", "xylophonic", "xenodochial"],
  Y: ["youthful", "yearning", "yielding", "yappy", "yonder"],
  Z: ["zealous", "zesty", "zingy", "zen", "zephyr-like"],
};

const namesByLetter: Record<string, string[]> = {
  A: ["Alice", "Alex", "Amy", "Arthur", "Ava"],
  B: ["Bob", "Bella", "Bill", "Brooke", "Ben"],
  C: ["Charlie", "Chloe", "Chris", "Clara", "Caleb"],
  D: ["David", "Diana", "Dylan", "Daisy", "Derek"],
  E: ["Emma", "Ethan", "Eva", "Evan", "Elizabeth"],
  F: ["Frank", "Fiona", "Felix", "Faith", "Finn"],
  G: ["Grace", "George", "Gavin", "Gabrielle", "Gina"],
  H: ["Henry", "Hannah", "Hugo", "Holly", "Hazel"],
  I: ["Ian", "Iris", "Isaac", "Isabella", "Ivy"],
  J: ["Jack", "Julia", "James", "Jasmine", "Jonah"],
  K: ["Kevin", "Kate", "Kyle", "Kaitlyn", "Kenneth"],
  L: ["Lily", "Luke", "Laura", "Logan", "Leah"],
  M: ["Michael", "Maya", "Mark", "Mia", "Matthew"],
  N: ["Noah", "Natalie", "Nathan", "Nora", "Nicole"],
  O: ["Oliver", "Olivia", "Oscar", "Ophelia", "Owen"],
  P: ["Paul", "Paige", "Peter", "Penelope", "Parker"],
  Q: ["Quentin", "Quinn", "Quiana", "Quincy", "Queenie"],
  R: ["Ryan", "Rachel", "Robert", "Rebecca", "Riley"],
  S: ["Sam", "Sarah", "Steven", "Sophia", "Scott"],
  T: ["Thomas", "Tina", "Tyler", "Tessa", "Theodore"],
  U: ["Ursula", "Ulysses", "Uma", "Ulrich", "Unity"],
  V: ["Victoria", "Vincent", "Violet", "Victor", "Vanessa"],
  W: ["William", "Wendy", "Walter", "Willow", "Wesley"],
  X: ["Xavier", "Xara", "Xerxes", "Xenia", "Ximena"],
  Y: ["Yolanda", "York", "Yasmin", "Yuri", "Yvonne"],
  Z: ["Zachary", "Zoe", "Zane", "Zara", "Zion"],
};

export function getRandomUsername(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const randomLetter = letters[Math.floor(Math.random() * letters.length)];

  const adjectives = adjectivesByLetter[randomLetter];
  const names = namesByLetter[randomLetter];

  const randomAdjective =
    adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomName = names[Math.floor(Math.random() * names.length)];

  return `${randomAdjective} ${randomName}`;
}
