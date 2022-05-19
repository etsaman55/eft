class QuestsAPI {
    async getList() {
        const quests = await ITEM_DATA.get('QUEST_DATA', 'json');

        if(!quests){
            return {};
        }
        const returnData = [];

        for(const quest of quests){
            const parsedQuestData = {
                ...quest,
                requirements: quest.require,
                wikiLink: quest.wiki,
                reputation: quest.reputation.map((reputationData) => {
                    return {
                        trader: reputationData.trader,
                        amount: reputationData.rep,
                    };
                }),
                objectives: quest.objectives.map((objectiveData) => {
                    const formattedObjective = {
                        ...objectiveData,
                    };

                    if(objectiveData.type === 'collect' || objectiveData.type === 'find' || objectiveData.type === 'place'){
                        formattedObjective.targetItem = formattedObjective.target;

                        if(!formattedObjective.targetItem.id){
                            //console.log(`${quest.id} - ${formattedObjective.target}`);
                            formattedObjective.targetItem = null;
                        }
                    } else if (objectiveData.type === 'mark') {
                        formattedObjective.targetItem = formattedObjective.tool;

                        if(!formattedObjective.targetItem.id){
                            //console.log(`${quest.id} - ${formattedObjective.tool}`);
                            formattedObjective.targetItem = null;
                        }
                    }

                    if(!Array.isArray(formattedObjective.target)){
                        formattedObjective.target = [formattedObjective.target];
                    }

                    return formattedObjective;
                }),
            };

            parsedQuestData.requirements.quests = parsedQuestData.requirements.quests.map((stringOrArray) => {
                if(Array.isArray(stringOrArray)){
                    return stringOrArray;
                }

                return [stringOrArray];
            });

            returnData.push(parsedQuestData);
        }

        for(const quest of returnData){
            if(quest.require.quests.length === 0){
                quest.require.prerequisiteQuests = [[]];
                continue;
            }

            let questsList = [];

            for(const questList of quest.require.quests){
                questsList.push(questList.map((id) => {
                    return returnData.find(tempQuest => tempQuest.id === id);
                }));
            }

            quest.require.prerequisiteQuests = questsList;
        }

        return returnData;
    }
}

module.exports = QuestsAPI
