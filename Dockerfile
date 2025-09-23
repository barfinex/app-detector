# Use a lightweight Node.js base image
FROM node:18.17.1-alpine3.18 AS development

# Set the working directory
WORKDIR /usr/src/app

# Copy only the root package.json and yarn.lock
COPY package.json yarn.lock ./

# Install root dependencies
RUN yarn install --frozen-lockfile

# Copy only the "detector" folder and essential config files
COPY apps/detector ./apps/detector
COPY libs ./libs
COPY nest-cli.json .
COPY tsconfig.json .
COPY tsconfig.build.json .
COPY config.json ./config.json

RUN yarn build:detector

CMD [ "yarn", "start:detector:prod" ]

# Install dependencies specific to the "detector" app
# WORKDIR /usr/src/app/apps/detector
# RUN yarn install --frozen-lockfile

# Build the project
# RUN yarn build:detector

# Specify the command to run the application
# CMD ["yarn", "start:detector:prod"]






# ###################
# # BUILD FOR LOCAL DEVELOPMENT
# ###################

# FROM node:18-alpine As development

# # Create app directory
# WORKDIR /usr/src/app

# # Copy application dependency manifests to the container image.
# # A wildcard is used to ensure copying both package.json AND package-lock.json (when available).
# # Copying this first prevents re-running npm install on every code change.
# COPY --chown=node:node package*.json ./

# # Install app dependencies using the `npm ci` command instead of `npm install`
# RUN npm ci

# # Bundle app source
# COPY --chown=node:node . .

# # Use the node user from the image (instead of the root user)
# USER node

# ###################
# # BUILD FOR PRODUCTION
# ###################

# FROM node:18-alpine As build

# WORKDIR /usr/src/app

# COPY --chown=node:node package*.json ./

# # In order to run `npm run build` we need access to the Nest CLI.
# # The Nest CLI is a dev dependency,
# # In the previous development stage we ran `npm ci` which installed all dependencies.
# # So we can copy over the node_modules directory from the development image into this build image.
# COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules

# COPY --chown=node:node . .

# # Run the build command which creates the production bundle
# RUN npm run build

# # Set NODE_ENV environment variable
# ENV NODE_ENV production

# # Running `npm ci` removes the existing node_modules directory.
# # Passing in --only=production ensures that only the production dependencies are installed.
# # This ensures that the node_modules directory is as optimized as possible.
# RUN npm ci --only=production && npm cache clean --force

# USER node

# ###################
# # PRODUCTION
# ###################

# FROM node:18-alpine As production

# # Copy the bundled code from the build stage to the production image
# COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
# COPY --chown=node:node --from=build /usr/src/app/dist ./dist

# # Start the server using the production build
# CMD [ "node", "dist/main.js" ]