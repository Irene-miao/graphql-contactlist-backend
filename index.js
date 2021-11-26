const { ApolloServer, UserInputError, AuthenticationError, gql } = require('apollo-server-express')
//const { v1: uuid } = require('uuid')
const { ApolloServerPluginDrainHttpServer } = require('apollo-server-core')
const express = require('express')
const { createServer } = require('http');
const { execute, subscribe } = require('graphql');
const { SubscriptionServer }  = require ('subscriptions-transport-ws');
const { makeExecutableSchema } = require ('@graphql-tools/schema');
const cors = require('cors')
const { PubSub } = require('graphql-subscriptions');

const jwt = require('jsonwebtoken')

const mongoose = require('mongoose')
const Person = require('./models/person')
const User = require('./models/user')
require('dotenv').config()

mongoose.connect(process.env.mongoUrl)
.then(() => {
  console.log('connected to MongoDB')
})
.catch((error) => {
  console.log('error connection to MongoDB:', error.message)
})

mongoose.set('debug', true)
 

 
const pubsub= new PubSub();

async function startApolloServer() {
 // GraphQl Schema
 const typeDefs = gql`
 type Person {
   name: String!
   phone: String
   address: Address!
   friendOf: [User!]!
   id: ID!
 }
 
 type Address {
   street: String!
   city: String!
 }
 
 enum YesNo {
   YES
   NO
 }
 
 type User {
   username: String!
   friends: [Person!]!
   id: ID!
   password: String!
 }
 
 type Token {
   value: String!
 }
 
 type Subscription {
   personAdded: Person!
 }
 
 type Query {
   personCount: Int!
   allPersons(phone: YesNo): [Person!]!
   findPerson(name: String!): Person
   me: User
   allUsers: [User]
 }
 
 type Mutation {
   addPerson(
     name: String!
     phone: String
     street: String!
     city: String!
   ): Person
   editNumber(
     name: String!
     phone: String!
   ): Person
   createUser(username: String!, password: String!): User
   login(
     username: String!
     password: String!
     ): Token
   addAsFriend(name: String!): User
 }
 `
 
 
 // Function for populating data for a single field in schema
 const resolvers = {
 Query: {
   personCount: () => Person.collection.countDocuments(),
   allPersons: (root, args) => {
       if (!args.phone) {
         console.log('Person.findv1')
         return Person.find({}).populate('friendOf').exec()
       }
       
    return Person.find({ phone: { $exists: args.phone === 'YES'}}).populate('friendOf').exec()
   },
   allUsers: async (root, args) => await User.find({}).exec(),
   findPerson: async (root, args) => await Person.findOne({ name: args.name }).exec(),
   me: (root, args, context) => {
     return context.currentUser
   }
 },
 Person: {
   address: (root) => {
     return {
       street: root.street,
       city: root.city,
     };
   },
   /*friendOf: async (root) => {
     // return list of users
     const friends = await User.find({
      friends: {
        $in: [root._id]
      }
     })
     console.log('User.find')
     return friends
   }*/
 },
 
 Mutation: {
   addPerson: async (root, args, context) => {
    const person = new Person({ ...args })
    const currentUser = context.currentUser
 
    if (!currentUser) {
      throw new AuthenticationError('not authenticated')
    }
    try {
     await person.save()
     currentUser.friends = currentUser.friends.concat(person)
     await currentUser.save()
    } catch (error) {
      throw new UserInputError(error.message, {
        invalidArgs: args,
      })
    }
 
    pubsub.publish('PERSON_ADDED', { personAdded: person})
 
    return person
   },
   editNumber: async (root, args, context) => {
     const currentUser = context.currentUser
 
         if (!currentUser) {
           throw new AuthenticationError("not authenticated")
         }
     
     try {
       const person = await Person.findOneAndUpdate({name: args.name}, {phone:args.phone}, {new: true}).exec()
      return person
     } catch (error) {
       throw new UserInputError(error.message, {
         invalidArgs: args,
       })
     }
     return person
 },
 createUser: (root, args) => {
   const user = new User({ username: args.username, password: args.password })
 
   return user.save()
   .catch(error => {
     throw new UserInputError(error.message, {
       invalidArgs: args,
     })
   })
 },
 login: async (root, args) => {
   const user =  await User.findOne({ username: args.username })
 
   if (!user || args.password !== user.password) {
     throw new UserInputError('wrong credentials')
   }
 
   const userForToken = {
     username: user.username,
     id: user._id,
   }
   return { value: jwt.sign(userForToken, process.env.SECRET)}
 },
 addAsFriend: async (root, args, { currentUser }) => {
   const nonFriendAlready = (person) =>
   !currentUser.friends.map(f => f._id).includes(person._id)
 
   if (!currentUser) {
     throw new AuthenticationError('not authenticated')
   }
 
   const person = await Person.findOne({ name: args.name })
   if ( nonFriendAlready(person) ) {
     currentUser.friends = currentUser.friends.concat(person)
   }
 
   await currentUser.save()
 
   return currentUser
 }
 },
 Subscription: {
 personAdded: {
   subscribe: () => pubsub.asyncIterator(['PERSON_ADDED'])
 }
 },
 }


  // Integrate with Express
  const app = express()
  const httpServer = createServer(app)
  const schema = makeExecutableSchema({ typeDefs, resolvers })
  

  // ApolloServer initialization
  const server = new ApolloServer({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
      async serverWillStart() {
        return {
          async drainServer() {
            subscriptionServer.close();
          }
        };
      }
    }],
    context: async ({ req }) => {
      const auth = req ? req.headers.authorization : null
      if (auth && auth.toLowerCase().startsWith('bearer')) {
        const decodedToken = jwt.verify(auth.substring(7), process.env.SECRET)
        const currentUser = await User.findById(decodedToken.id)
        return { currentUser }
      }
    }
  });

  // SubscriptionServer Initialization
  const subscriptionServer = SubscriptionServer.create({
    // This is the `schema` we just created.
    schema,
    // These are imported from `graphql`.
    execute,
    subscribe,
 }, {
    // This is the `httpServer` we created in a previous step.
    server: httpServer,
    // This `server` is the instance returned from `new ApolloServer`.
    path: server.graphqlPath,
 });
 
  
  await server.start();
  app.use(cors('*'))
  app.use(express.static('build'))
  server.applyMiddleware({ app});

  const PORT = process.env.PORT;
  httpServer.listen(PORT , () => {
    console.log(`Server ready at http://localhost:${PORT}/graphql`);
  });
};

startApolloServer();