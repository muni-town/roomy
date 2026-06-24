/**
 * Shared type for the user-typeahead UI and the TipTap `@mention` suggestion
 * renderer. Kept in its own module so the presentational list
 * (`UserTypeaheadList.svelte`) and the input component (`UserTypeahead.svelte`)
 * can both import it without a circular dependency.
 */
export type TypeaheadUser = {
  did: string;
  handle?: string;
  name?: string;
  avatar?: string;
};