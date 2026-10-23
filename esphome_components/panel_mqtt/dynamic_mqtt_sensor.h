#pragma once

#include <string>
#include <cmath>

#include "esphome/components/mqtt/mqtt_client.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/core/component.h"
#include "esphome/core/helpers.h"

namespace esphome::panel_mqtt {

class DynamicMqttSensor : public sensor::Sensor, public Component {
 public:
  void set_topic_suffix(const std::string &topic_suffix) { topic_suffix_ = topic_suffix; }
  void set_qos(uint8_t qos) { qos_ = qos; }

  void setup() override {
    const std::string topic = mqtt::global_mqtt_client->get_topic_prefix() + "/" + topic_suffix_;
    mqtt::global_mqtt_client->subscribe(topic, [this](const std::string &, const std::string &payload) {
      const auto value = parse_number<float>(payload);
      this->publish_state(value.has_value() ? *value : NAN);
    }, qos_);
  }

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

 protected:
  std::string topic_suffix_;
  uint8_t qos_{0};
};

}  // namespace esphome::panel_mqtt
