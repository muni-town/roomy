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
  R: ["radiant", "resourceful", "rapid", "robust", "resilient"],
  S: ["swift", "spirited", "stellar", "shining", "smart"],
  T: ["terrific", "thoughtful", "tenacious", "tranquil", "talented"],
  U: ["unique", "upbeat", "ultimate", "useful", "unbreakable"],
  V: ["vibrant", "valiant", "victorious", "vivid", "versatile"],
  W: ["witty", "wise", "wonderful", "whimsical", "warm"],
  X: ["xenial", "xanthic", "xenodochial", "xeric", "xyloid"],
  Y: ["youthful", "yummy", "yearning", "yielding", "yare"],
  Z: ["zealous", "zany", "zesty", "zen", "zippy"],
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
  U: ["Ulysses", "Una", "Ursula", "Uriel", "Ulric"],
  V: ["Victor", "Victoria", "Vincent", "Vanessa", "Violet"],
  W: ["William", "Wendy", "Wyatt", "Willow", "Wesley"],
  X: ["Xavier", "Xander", "Ximena", "Xenia", "Xiomara"],
  Y: ["Yara", "Yvonne", "Yusef", "Yolanda", "Yusuf"],
  Z: ["Zachary", "Zoe", "Zane", "Zara", "Zuri"],
};

export function getRandomUsername(): string {
  const letters = Object.keys(adjectivesByLetter);

  const randomLetter = letters[
    Math.floor(Math.random() * letters.length)
  ] as keyof typeof adjectivesByLetter;

  const adjectives = adjectivesByLetter[randomLetter] ?? [];
  const names = namesByLetter[randomLetter] ?? [];
  const adjective =
    adjectives[Math.floor(Math.random() * adjectives.length)] ?? "";
  const name = names[Math.floor(Math.random() * names.length)] ?? "";

  return `${adjective} ${name}`.toLowerCase();
}
