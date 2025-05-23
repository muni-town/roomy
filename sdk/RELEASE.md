# Release Process

We use [beachball](https://microsoft.github.io/beachball/) for relase management.

## Development

When changes are made it's good to create a changeset by running:

```
npx beachball change
```

## Publishing

When ready to publish crates first you want bump the package versions and make sure all of the new versions look good:

```
npx beachball bump
```

As long as that all looks like you expected you can rever the changes back:

```
git checkout -- .
```

Finally you can publish the crates by running:

```
pnpm run publish-packages --token npm_yourNpmPublishT0ken
```

That will make sure all the packages are built and then it will publish them with beachball.